import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../config/database';
import type { TipoTokenUsuario } from '../../generated/prisma/client';

export interface ContextoToken {
  ip?: string | null;
  userAgent?: string | null;
}

/** Só o hash SHA-256 do token é gravado: quem ler o banco não consegue montar um link válido. */
export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const novoToken = (): string => randomBytes(32).toString('base64url'); // 256 bits de entropia

/**
 * Emite um token de uso único e revoga os anteriores ainda pendentes do mesmo tipo (só o link mais recente vale).
 * Devolve o token em claro — ele só existe aqui e no e-mail enviado.
 */
export async function emitirToken(usuarioId: string, tipo: TipoTokenUsuario, ttlMs: number, ctx: ContextoToken = {}): Promise<string> {
  const raw = novoToken();
  const agora = new Date();
  await prisma.$transaction([
    prisma.tokenUsuario.updateMany({ where: { usuarioId, tipo, usadoEm: null, revogadoEm: null }, data: { revogadoEm: agora } }),
    prisma.tokenUsuario.create({
      data: {
        usuarioId,
        tipo,
        tokenHash: hashToken(raw),
        expiraEm: new Date(agora.getTime() + ttlMs),
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      },
    }),
  ]);
  return raw;
}

/** Token válido = existe, é do tipo certo, não foi usado nem revogado, não expirou e a conta está ativa. Sem motivo detalhado. */
export async function localizarTokenValido(raw: string, tipo: TipoTokenUsuario) {
  if (!raw || raw.length < 20 || raw.length > 200) return null;
  const t = await prisma.tokenUsuario.findUnique({ where: { tokenHash: hashToken(raw) }, include: { usuario: true } });
  if (!t || t.tipo !== tipo || t.usadoEm || t.revogadoEm || t.expiraEm <= new Date() || !t.usuario.ativo) return null;
  return t;
}

/** Consome o token de forma atômica (compare-and-swap): de duas requisições simultâneas, só uma vence. */
export async function consumirToken(id: string): Promise<boolean> {
  const r = await prisma.tokenUsuario.updateMany({
    where: { id, usadoEm: null, revogadoEm: null, expiraEm: { gt: new Date() } },
    data: { usadoEm: new Date() },
  });
  return r.count === 1;
}

export function revogarTokens(usuarioId: string, tipo?: TipoTokenUsuario) {
  return prisma.tokenUsuario.updateMany({
    where: { usuarioId, usadoEm: null, revogadoEm: null, ...(tipo ? { tipo } : {}) },
    data: { revogadoEm: new Date() },
  });
}

/** Quantos tokens de um tipo foram emitidos para a conta na última hora (limite por conta, além do limite por IP). */
export function contarEmitidosNaUltimaHora(usuarioId: string, tipo: TipoTokenUsuario): Promise<number> {
  return prisma.tokenUsuario.count({ where: { usuarioId, tipo, criadoEm: { gt: new Date(Date.now() - 3_600_000) } } });
}
