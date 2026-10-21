import { z } from 'zod';

const perfil = z.enum(['ADMIN', 'FINANCEIRO', 'ANALISTA', 'LEITURA']);

export const idParams = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  busca: z.string().trim().max(100).optional(),
  perfil: perfil.optional(),
  ativo: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const createBody = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  perfil,
  senhaTemporaria: z.string().min(12).max(256),
});

export const updateBody = z
  .object({
    nome: z.string().trim().min(2).max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

export const statusBody = z.object({ ativo: z.boolean() });
export const perfilBody = z.object({ perfil });
