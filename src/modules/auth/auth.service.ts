import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { enviarEmail } from '../../shared/services/mail.service';
import { emailContaBloqueada, emailRedefinicao, emailSenhaAlterada } from '../../shared/services/mail.templates';
import { hashPassword, passwordPolicyIssue, verifyPassword } from './password.service';
import { consumirToken, contarEmitidosNaUltimaHora, emitirToken, localizarTokenValido, revogarTokens } from './token-usuario.service';
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
  email: string | null;
  usuario: string | null;
  perfil: string;
  trocaSenhaObrigatoria: boolean;
}

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toPublic(u: { id: string; nome: string; email: string | null; usuario: string | null; perfil: string; trocaSenhaObrig: boolean }): PublicUser {
  return { id: u.id, nome: u.nome, email: u.email, usuario: u.usuario, perfil: u.perfil, trocaSenhaObrigatoria: u.trocaSenhaObrig };
}

/** Resposta de erro idêntica para qualquer problema de link: nunca diz se expirou, já foi usado ou nunca existiu. */
const linkInvalido = () => Errors.badRequest('Link inválido ou expirado. Solicite um novo.');

const MENSAGEM_SENHA_REUSADA = 'Essa senha já foi usada recentemente. Escolha uma senha diferente';

/** A senha nova não pode repetir a atual nem as últimas N. */
async function senhaReaproveitada(usuarioId: string, senhaHashAtual: string, nova: string): Promise<boolean> {
  if (await verifyPassword(senhaHashAtual, nova)) return true;
  if (env.PASSWORD_HISTORY === 0) return false;
  const anteriores = await prisma.senhaHistorico.findMany({ where: { usuarioId }, orderBy: { criadoEm: 'desc' }, take: env.PASSWORD_HISTORY });
  for (const h of anteriores) if (await verifyPassword(h.senhaHash, nova)) return true;
  return false;
}

export class AuthService {
  /** `login` pode ser o e-mail (tem @) ou o nome de usuário. */
  async login(login: string, senha: string, ctx: SessionContext): Promise<AuthResult> {
    const usuario = await prisma.usuario.findUnique({ where: login.includes('@') ? { email: login } : { usuario: login } });
    const valid = await verifyPassword(usuario?.senhaHash ?? null, senha);
    const bloqueado = !!usuario?.bloqueadoAte && usuario.bloqueadoAte > new Date();

    // Mesma resposta para login inexistente, senha errada, conta inativa, convite pendente ou conta bloqueada.
    if (!usuario || !valid || !usuario.ativo || bloqueado) {
      if (usuario?.ativo && !valid && !bloqueado) await this.registrarFalha(usuario, ctx);
      else if (usuario && bloqueado) await audit(null, 'auth.login_bloqueado', 'usuario', usuario.id, { ip: ctx.ip }, usuario.id);
      throw Errors.unauthorized('Credenciais inválidas');
    }

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
    await prisma.usuario.update({ where: { id: usuario.id }, data: { ultimoLoginEm: new Date(), falhasLogin: 0, bloqueadoAte: null } });
    const access = signAccessToken(usuario.id, sessao.id);
    return { accessToken: access.token, expiresIn: access.expiresInSeconds, refreshToken, usuario: toPublic(usuario) };
  }

  /** Conta falhas consecutivas (incremento atômico); ao atingir o limite bloqueia por LOGIN_LOCK_MINUTES e avisa o titular por e-mail. */
  private async registrarFalha(usuario: { id: string; nome: string; email: string | null }, ctx: SessionContext): Promise<void> {
    const atual = await prisma.usuario.update({ where: { id: usuario.id }, data: { falhasLogin: { increment: 1 } }, select: { falhasLogin: true } });
    if (atual.falhasLogin < env.LOGIN_MAX_FAILURES) return;
    await prisma.usuario.update({
      where: { id: usuario.id },
      data: { falhasLogin: 0, bloqueadoAte: new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) },
    });
    await audit(null, 'auth.conta_bloqueada', 'usuario', usuario.id, { ip: ctx.ip, minutos: env.LOGIN_LOCK_MINUTES }, usuario.id);
    if (usuario.email) void enviarEmail(emailContaBloqueada(usuario.email, usuario.nome, env.LOGIN_LOCK_MINUTES, { ip: ctx.ip }));
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

  /** Grava a nova senha, guarda a anterior no histórico, zera o bloqueio e encerra as sessões (menos `manterSessaoId`). */
  private async aplicarNovaSenha(
    u: { id: string; senhaHash: string },
    nova: string,
    opts: { manterSessaoId?: string } = {},
  ): Promise<void> {
    const novoHash = await hashPassword(nova);
    const agora = new Date();
    await prisma.$transaction([
      prisma.senhaHistorico.create({ data: { usuarioId: u.id, senhaHash: u.senhaHash } }),
      prisma.usuario.update({
        where: { id: u.id },
        data: { senhaHash: novoHash, senhaAlteradaEm: agora, trocaSenhaObrig: false, convitePendente: false, falhasLogin: 0, bloqueadoAte: null },
      }),
      prisma.sessao.updateMany({
        where: { usuarioId: u.id, revogadaEm: null, ...(opts.manterSessaoId ? { NOT: { id: opts.manterSessaoId } } : {}) },
        data: { revogadaEm: agora },
      }),
    ]);
    await revogarTokens(u.id); // qualquer link pendente (reset ou convite) deixa de valer
    // poda o histórico além do limite configurado
    const manter = await prisma.senhaHistorico.findMany({ where: { usuarioId: u.id }, orderBy: { criadoEm: 'desc' }, take: Math.max(env.PASSWORD_HISTORY, 1), select: { id: true } });
    await prisma.senhaHistorico.deleteMany({ where: { usuarioId: u.id, id: { notIn: manter.map((m) => m.id) } } });
  }

  async changePassword(userId: string, currentSessionId: string, atual: string, nova: string, ctx: SessionContext = {}): Promise<void> {
    const u = await prisma.usuario.findUnique({ where: { id: userId } });
    if (!u || !(await verifyPassword(u.senhaHash, atual))) throw Errors.unauthorized('Senha atual incorreta');
    const issue = passwordPolicyIssue(nova, { email: u.email, usuario: u.usuario, nome: u.nome });
    if (issue) throw Errors.validation([{ path: 'novaSenha', message: issue }]);
    if (await senhaReaproveitada(u.id, u.senhaHash, nova)) {
      throw Errors.validation([{ path: 'novaSenha', message: MENSAGEM_SENHA_REUSADA }]);
    }
    await this.aplicarNovaSenha(u, nova, { manterSessaoId: currentSessionId }); // encerra as OUTRAS sessões
    if (u.email) void enviarEmail(emailSenhaAlterada(u.email, u.nome, { ip: ctx.ip }));
  }

  /**
   * "Esqueci minha senha". Resposta SEMPRE igual (existindo ou não a conta), com tempo mínimo fixo para não revelar a diferença.
   * Limites: por IP (middleware) e por conta (FORGOT_PASSWORD_MAX_PER_HOUR). O e-mail é enviado em segundo plano.
   */
  async solicitarRedefinicao(email: string, ctx: SessionContext): Promise<void> {
    const trabalho = async () => {
      const u = await prisma.usuario.findUnique({ where: { email } });
      if (!u || !u.ativo || !u.email) return;
      if ((await contarEmitidosNaUltimaHora(u.id, 'RESET_SENHA')) >= env.FORGOT_PASSWORD_MAX_PER_HOUR) {
        await audit(null, 'auth.reset_limite_conta', 'usuario', u.id, { ip: ctx.ip }, u.id);
        return;
      }
      const token = await emitirToken(u.id, 'RESET_SENHA', env.RESET_TOKEN_TTL_MINUTES * 60_000, ctx);
      await audit(null, 'auth.reset_solicitado', 'usuario', u.id, { ip: ctx.ip }, u.id);
      void enviarEmail(emailRedefinicao(u.email, u.nome, token));
    };
    await Promise.all([trabalho().catch((e) => logger.error({ erro: e instanceof Error ? e.message : String(e) }, 'Falha ao processar redefinição')), dorme(300)]);
  }

  /** Confere se o link ainda é utilizável (a tela decide se mostra o formulário). Não revela por que é inválido. */
  async validarLink(token: string): Promise<{ valido: boolean; tipo: 'RESET_SENHA' | 'CONVITE' | null }> {
    const reset = await localizarTokenValido(token, 'RESET_SENHA');
    if (reset) return { valido: true, tipo: 'RESET_SENHA' };
    const convite = await localizarTokenValido(token, 'CONVITE');
    return convite ? { valido: true, tipo: 'CONVITE' } : { valido: false, tipo: null };
  }

  /** Conclui redefinição de senha (RESET_SENHA) ou ativação de conta (CONVITE) a partir do link recebido por e-mail. */
  async concluirComLink(tipo: 'RESET_SENHA' | 'CONVITE', token: string, nova: string, ctx: SessionContext): Promise<void> {
    const t = await localizarTokenValido(token, tipo);
    if (!t) throw linkInvalido();
    const u = t.usuario;

    // valida a senha ANTES de consumir o token: um erro de digitação não queima o link
    const issue = passwordPolicyIssue(nova, { email: u.email, usuario: u.usuario, nome: u.nome });
    if (issue) throw Errors.validation([{ path: 'novaSenha', message: issue }]);
    if (tipo === 'RESET_SENHA' && (await senhaReaproveitada(u.id, u.senhaHash, nova))) {
      throw Errors.validation([{ path: 'novaSenha', message: MENSAGEM_SENHA_REUSADA }]);
    }

    if (!(await consumirToken(t.id))) throw linkInvalido(); // outra requisição usou o link no mesmo instante
    await this.aplicarNovaSenha(u, nova);
    await audit(null, tipo === 'RESET_SENHA' ? 'auth.reset_concluido' : 'auth.convite_aceito', 'usuario', u.id, { ip: ctx.ip }, u.id);
    if (u.email) void enviarEmail(emailSenhaAlterada(u.email, u.nome, { ip: ctx.ip }));
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
