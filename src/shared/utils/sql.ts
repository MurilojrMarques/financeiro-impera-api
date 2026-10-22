import { Prisma } from '../../generated/prisma/client';

/** Instante ISO (UTC) com cast explícito: o resultado não depende do fuso da sessão do banco. */
export const tsz = (d: Date): Prisma.Sql => Prisma.sql`${d.toISOString()}::timestamptz`;
