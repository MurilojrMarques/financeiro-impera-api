import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { Errors } from '../../shared/errors/app-error';
import { hashPassword, passwordPolicyIssue, verifyPassword } from './password.service';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './token.service';

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  usuario: PublicUser;
}

export interface PublicUser {
  id: string;
  nome: string;
  email: string;
  perfil: string;
  trocaSenhaObrigatoria: boolean;
}

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

function toPublic(u: { id: string; nome: string; email: string; perfil: string; trocaSenhaObrig: boolean }): PublicUser {
  return { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, trocaSenhaObrigatoria: u.trocaSenhaObrig };
}

export class AuthService {
  async login(email: string, senha: string, ctx: SessionContext): Promise<AuthResult> {
    const usuario = await prisma.usuario.findUnique({ where: { email } });
    const valid = await verifyPassword(usuario?.senhaHash ?? null, senha);
    // Mesma resposta para e-mail inexistente, senha errada ou conta inativa.
    if (!usuario || !valid || !usuario.ativo) throw Errors.unauthorized('Credenciais inválidas');

    const refreshToken = generateRefreshToken();
    const sessao = await prisma.sessao.create({
      data: {
        usuarioId: usuario.id,
        refreshHash: hashRefreshToken(refreshToken),
        expiraEm: refreshExpiry(),
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      },
    });
    await prisma.usuario.update({ where: { id: usuario.id }, data: { ultimoLoginEm: new Date() } });
    const access = signAccessToken(usuario.id, sessao.id);
    return { accessToken: access.token, expiresIn: access.expiresInSeconds, refreshToken, usuario: toPublic(usuario) };
  }

  /** Rotaciona o refresh token. Reuso de token antigo revoga a sessão inteira. */
  async refresh(presented: string, ctx: SessionContext): Promise<AuthResult> {
    const hash = hashRefreshToken(presented);
    const sessao = await prisma.sessao.findUnique({ where: { refreshHash: hash }, include: { usuario: true } });

    if (!sessao) {
      const reused = await prisma.sessao.findFirst({ where: { refreshAnterior: hash } });
      if (reused && !reused.revogadaEm) {
        await prisma.sessao.update({ where: { id: reused.id }, data: { revogadaEm: new Date() } });
      }
      throw Errors.unauthorized();
    }
    if (sessao.revogadaEm || sessao.expiraEm < new Date() || !sessao.usuario.ativo) throw Errors.unauthorized();

    const novo = generateRefreshToken();
    // compare-and-swap: só um refresh concorrente vence
    const swapped = await prisma.sessao.updateMany({
      where: { id: sessao.id, refreshHash: hash, revogadaEm: null },
      data: {
        refreshHash: hashRefreshToken(novo),
        refreshAnterior: hash,
        expiraEm: refreshExpiry(),
        ultimoUsoEm: new Date(),
        ip: ctx.ip ?? sessao.ip,
      },
    });
    if (swapped.count !== 1) throw Errors.unauthorized();

    const access = signAccessToken(sessao.usuarioId, sessao.id);
    return { accessToken: access.token, expiresIn: access.expiresInSeconds, refreshToken: novo, usuario: toPublic(sessao.usuario) };
  }

  async logoutByRefresh(presented: string): Promise<void> {
    await prisma.sessao.updateMany({
      where: { refreshHash: hashRefreshToken(presented), revogadaEm: null },
      data: { revogadaEm: new Date() },
    });
  }

  async logoutSession(sessaoId: string): Promise<void> {
    await prisma.sessao.updateMany({ where: { id: sessaoId, revogadaEm: null }, data: { revogadaEm: new Date() } });
  }

  async logoutAll(userId: string): Promise<number> {
    const r = await prisma.sessao.updateMany({ where: { usuarioId: userId, revogadaEm: null }, data: { revogadaEm: new Date() } });
    return r.count;
  }

  async me(userId: string): Promise<PublicUser> {
    const u = await prisma.usuario.findUnique({ where: { id: userId } });
    if (!u) throw Errors.unauthorized();
    return toPublic(u);
  }

  async changePassword(userId: string, currentSessionId: string, atual: string, nova: string): Promise<void> {
    const u = await prisma.usuario.findUnique({ where: { id: userId } });
    if (!u || !(await verifyPassword(u.senhaHash, atual))) throw Errors.unauthorized('Senha atual incorreta');
    const issue = passwordPolicyIssue(nova);
    if (issue) throw Errors.validation([{ path: 'novaSenha', message: issue }]);
    if (await verifyPassword(u.senhaHash, nova)) {
      throw Errors.validation([{ path: 'novaSenha', message: 'A nova senha deve ser diferente da atual' }]);
    }
    await prisma.usuario.update({
      where: { id: userId },
      data: { senhaHash: await hashPassword(nova), trocaSenhaObrig: false },
    });
    // Encerra todas as outras sessões após troca de senha.
    await prisma.sessao.updateMany({
      where: { usuarioId: userId, revogadaEm: null, NOT: { id: currentSessionId } },
      data: { revogadaEm: new Date() },
    });
  }

  listSessions(userId: string) {
    return prisma.sessao.findMany({
      where: { usuarioId: userId, revogadaEm: null, expiraEm: { gt: new Date() } },
      select: { id: true, ip: true, userAgent: true, criadoEm: true, ultimoUsoEm: true, expiraEm: true },
      orderBy: { ultimoUsoEm: 'desc' },
    });
  }

  async revokeOwnSession(userId: string, sessaoId: string): Promise<void> {
    const r = await prisma.sessao.updateMany({
      where: { id: sessaoId, usuarioId: userId, revogadaEm: null },
      data: { revogadaEm: new Date() },
    });
    if (r.count === 0) throw Errors.notFound('Sessão não encontrada');
  }
}

export const authService = new AuthService();
