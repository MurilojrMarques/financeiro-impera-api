import type { Request } from 'express';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import type { Prisma } from '../../generated/prisma/client';

const SENSITIVE = /senha|password|token|secret|hash/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : scrub(v)]),
    );
  }
  return value;
}

export async function audit(
  req: Request | null,
  acao: string,
  entidade?: string,
  entidadeId?: string,
  detalhes?: unknown,
  usuarioIdOverride?: string,
): Promise<void> {
  try {
    await prisma.auditoria.create({
      data: {
        usuarioId: usuarioIdOverride ?? req?.user?.id ?? null,
        acao,
        entidade,
        entidadeId,
        detalhes: detalhes === undefined ? undefined : (scrub(detalhes) as Prisma.InputJsonValue),
        ip: req?.ip ?? null,
      },
    });
  } catch (err) {
    // Falha de auditoria não deve derrubar a requisição, mas precisa ser visível.
    logger.error({ err, acao }, 'falha ao registrar auditoria');
  }
}
