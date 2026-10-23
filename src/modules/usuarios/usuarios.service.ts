import { prisma } from '../../config/database';
import type { PerfilUsuario, Prisma } from '../../generated/prisma/client';
import { Errors } from '../../shared/errors/app-error';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { emailConfigurado, enviarEmail } from '../../shared/services/mail.service';
import { emailConvite, emailRedefinicao } from '../../shared/services/mail.templates';
import { hashPassword, passwordPolicyIssue } from '../auth/password.service';
import { emitirToken, revogarTokens } from '../auth/token-usuario.service';

const publicSelect = {
  id: true,
  nome: true,
  email: true,
  usuario: true,
  perfil: true,
  ativo: true,
  trocaSenhaObrig: true,
  convitePendente: true,
  bloqueadoAte: true,
  senhaAlteradaEm: true,
  ultimoLoginEm: true,
  criadoEm: true,
} satisfies Prisma.UsuarioSelect;

export class UsuariosService {
  async list(q: { page: number; limit: number; busca?: string; perfil?: PerfilUsuario; ativo?: boolean }) {
    const where: Prisma.UsuarioWhereInput = {
      ...(q.perfil ? { perfil: q.perfil } : {}),
      ...(q.ativo !== undefined ? { ativo: q.ativo } : {}),
      ...(q.busca
        ? { OR: [{ nome: { contains: q.busca, mode: 'insensitive' } }, { email: { contains: q.busca, mode: 'insensitive' } }, { usuario: { contains: q.busca, mode: 'insensitive' } }] }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.usuario.count({ where }),
      prisma.usuario.findMany({ where, select: publicSelect, orderBy: { nome: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { total, items };
  }

  async get(id: string) {
    const u = await prisma.usuario.findUnique({ where: { id }, select: publicSelect });
    if (!u) throw Errors.notFound('Usuário não encontrado');
    return u;
  }

  /**
   * Cria o usuário. Sem `senhaTemporaria` (fluxo recomendado) é um CONVITE: a conta nasce com uma senha aleatória inutilizável e o próprio
   * usuário define a senha pelo link de uso único enviado por e-mail (o administrador nunca conhece a senha). Com `senhaTemporaria`
   * (legado) a conta exige troca no primeiro acesso.
   */
  async create(actorId: string, input: { nome: string; email?: string; usuario?: string; perfil: PerfilUsuario; senhaTemporaria?: string }) {
    await this.garantirLivre(input.email, input.usuario);
    if (input.senhaTemporaria) {
      const issue = passwordPolicyIssue(input.senhaTemporaria, { email: input.email, usuario: input.usuario, nome: input.nome });
      if (issue) throw Errors.validation([{ path: 'senhaTemporaria', message: issue }]);
      const u = await prisma.usuario.create({
        data: {
          nome: input.nome, email: input.email ?? null, usuario: input.usuario ?? null, perfil: input.perfil,
          senhaHash: await hashPassword(input.senhaTemporaria), trocaSenhaObrig: true,
        },
        select: publicSelect,
      });
      return { ...u, conviteEnviado: false };
    }
    if (!input.email) throw Errors.validation([{ path: 'senhaTemporaria', message: 'Sem e-mail não é possível enviar convite: informe uma senha inicial' }]);
    if (!emailConfigurado()) throw Errors.unavailable('Envio de e-mail não configurado: não é possível enviar o convite');
    const u = await prisma.usuario.create({
      data: {
        nome: input.nome,
        email: input.email,
        usuario: input.usuario ?? null,
        perfil: input.perfil,
        senhaHash: await hashPassword(randomBytes(48).toString('base64url')), // ninguém conhece esta senha
        convitePendente: true,
      },
      select: publicSelect,
    });
    const conviteEnviado = await this.enviarConvite(actorId, u.id);
    return { ...u, conviteEnviado };
  }

  /** E-mail e usuário são únicos (o usuário é guardado em minúsculas, então a comparação não diferencia maiúsculas). */
  private async garantirLivre(email: string | null | undefined, usuario: string | null | undefined, exceto?: string): Promise<void> {
    if (email) {
      const o = await prisma.usuario.findUnique({ where: { email }, select: { id: true } });
      if (o && o.id !== exceto) throw Errors.conflict('E-mail já cadastrado');
    }
    if (usuario) {
      const o = await prisma.usuario.findUnique({ where: { usuario }, select: { id: true } });
      if (o && o.id !== exceto) throw Errors.conflict('Usuário já cadastrado');
    }
  }

  /** (Re)emite o convite: o link anterior deixa de valer. */
  async enviarConvite(actorId: string, id: string): Promise<boolean> {
    const u = await prisma.usuario.findUnique({ where: { id } });
    if (!u) throw Errors.notFound('Usuário não encontrado');
    if (!u.email) throw Errors.conflict('Este usuário não tem e-mail cadastrado');
    if (!u.convitePendente) throw Errors.conflict('Este usuário já ativou a conta');
    if (!u.ativo) throw Errors.conflict('Usuário desativado');
    const actor = await prisma.usuario.findUnique({ where: { id: actorId }, select: { nome: true } });
    const token = await emitirToken(u.id, 'CONVITE', env.INVITE_TOKEN_TTL_HOURS * 3_600_000);
    return enviarEmail(emailConvite(u.email, u.nome, u.perfil, token, actor?.nome ?? 'Um administrador'));
  }

  /** Redefinição iniciada por um administrador: envia ao usuário o link de criação de nova senha (o admin nunca vê a senha). */
  async enviarRedefinicao(id: string): Promise<boolean> {
    const u = await prisma.usuario.findUnique({ where: { id } });
    if (!u) throw Errors.notFound('Usuário não encontrado');
    if (!u.ativo) throw Errors.conflict('Usuário desativado');
    if (!u.email) throw Errors.conflict('Este usuário não tem e-mail cadastrado');
    if (u.convitePendente) throw Errors.conflict('O usuário ainda não ativou a conta: reenvie o convite');
    if (!emailConfigurado()) throw Errors.unavailable('Envio de e-mail não configurado');
    const token = await emitirToken(u.id, 'RESET_SENHA', env.RESET_TOKEN_TTL_MINUTES * 60_000);
    return enviarEmail(emailRedefinicao(u.email, u.nome, token));
  }

  async desbloquear(id: string) {
    await this.get(id);
    return prisma.usuario.update({ where: { id }, data: { falhasLogin: 0, bloqueadoAte: null }, select: publicSelect });
  }

  async update(id: string, data: { nome?: string; email?: string | null; usuario?: string | null }) {
    const atual = await prisma.usuario.findUnique({ where: { id }, select: { email: true, usuario: true } });
    if (!atual) throw Errors.notFound('Usuário não encontrado');
    const email = data.email === undefined ? atual.email : data.email;
    const usuario = data.usuario === undefined ? atual.usuario : data.usuario;
    if (!email && !usuario) throw Errors.validation([{ path: 'usuario', message: 'A conta precisa ter e-mail ou usuário' }]);
    await this.garantirLivre(data.email, data.usuario, id);
    const u = await prisma.usuario.update({ where: { id }, data, select: publicSelect });
    // links pendentes foram emitidos para o e-mail antigo: deixam de valer
    if (data.email !== undefined && data.email !== atual.email) await revogarTokens(id);
    return u;
  }

  async setStatus(actorId: string, id: string, ativo: boolean) {
    if (!ativo && id === actorId) throw Errors.conflict('Você não pode desativar a própria conta');
    await this.get(id);
    const u = await prisma.usuario.update({ where: { id }, data: { ativo }, select: publicSelect });
    if (!ativo) {
      await prisma.sessao.updateMany({ where: { usuarioId: id, revogadaEm: null }, data: { revogadaEm: new Date() } });
      await revogarTokens(id);
    }
    return u;
  }

  async setPerfil(actorId: string, id: string, perfil: PerfilUsuario) {
    if (id === actorId) throw Errors.conflict('Você não pode alterar o próprio perfil');
    await this.get(id);
    return prisma.usuario.update({ where: { id }, data: { perfil }, select: publicSelect });
  }

  /** Desativação lógica (preserva auditoria e relacionamentos). */
  async remove(actorId: string, id: string) {
    await this.setStatus(actorId, id, false);
  }
}

export const usuariosService = new UsuariosService();
