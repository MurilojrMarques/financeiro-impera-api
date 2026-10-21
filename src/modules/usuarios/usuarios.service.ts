import { prisma } from '../../config/database';
import type { PerfilUsuario, Prisma } from '../../generated/prisma/client';
import { Errors } from '../../shared/errors/app-error';
import { hashPassword, passwordPolicyIssue } from '../auth/password.service';

const publicSelect = {
  id: true,
  nome: true,
  email: true,
  perfil: true,
  ativo: true,
  trocaSenhaObrig: true,
  ultimoLoginEm: true,
  criadoEm: true,
} satisfies Prisma.UsuarioSelect;

export class UsuariosService {
  async list(q: { page: number; limit: number; busca?: string; perfil?: PerfilUsuario; ativo?: boolean }) {
    const where: Prisma.UsuarioWhereInput = {
      ...(q.perfil ? { perfil: q.perfil } : {}),
      ...(q.ativo !== undefined ? { ativo: q.ativo } : {}),
      ...(q.busca
        ? { OR: [{ nome: { contains: q.busca, mode: 'insensitive' } }, { email: { contains: q.busca, mode: 'insensitive' } }] }
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

  async create(input: { nome: string; email: string; perfil: PerfilUsuario; senhaTemporaria: string }) {
    const issue = passwordPolicyIssue(input.senhaTemporaria);
    if (issue) throw Errors.validation([{ path: 'senhaTemporaria', message: issue }]);
    if (await prisma.usuario.findUnique({ where: { email: input.email }, select: { id: true } })) {
      throw Errors.conflict('E-mail já cadastrado');
    }
    return prisma.usuario.create({
      data: {
        nome: input.nome,
        email: input.email,
        perfil: input.perfil,
        senhaHash: await hashPassword(input.senhaTemporaria),
        trocaSenhaObrig: true,
      },
      select: publicSelect,
    });
  }

  async update(id: string, data: { nome?: string; email?: string }) {
    await this.get(id);
    if (data.email) {
      const other = await prisma.usuario.findUnique({ where: { email: data.email }, select: { id: true } });
      if (other && other.id !== id) throw Errors.conflict('E-mail já cadastrado');
    }
    return prisma.usuario.update({ where: { id }, data, select: publicSelect });
  }

  async setStatus(actorId: string, id: string, ativo: boolean) {
    if (!ativo && id === actorId) throw Errors.conflict('Você não pode desativar a própria conta');
    await this.get(id);
    const u = await prisma.usuario.update({ where: { id }, data: { ativo }, select: publicSelect });
    if (!ativo) await prisma.sessao.updateMany({ where: { usuarioId: id, revogadaEm: null }, data: { revogadaEm: new Date() } });
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
