import { z } from 'zod';
import { GRUPOS } from '../../shared/validators/filtros';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const centavos = z.number().int().positive().max(2_000_000_000);

export const idParams = z.object({ id: z.string().uuid() });
export const anexoParams = z.object({ id: z.string().uuid(), anexoId: z.string().uuid() });

export const listaQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  de: ymd.optional(),
  ate: ymd.optional(),
  categoriaId: z.string().uuid().optional(),
  status: z.enum(['PENDENTE', 'PAGO', 'CANCELADO']).optional(),
  grupo: z.enum(GRUPOS).optional(),
  busca: z.string().trim().max(100).optional(),
  sortBy: z.enum(['vencimento', 'valorCentavos', 'descricao', 'criadoEm']).default('vencimento'),
  sortOrder: z.enum(['ASC', 'DESC']).default('DESC'),
});

export const criarCustoBody = z.object({
  descricao: z.string().trim().min(2).max(200),
  tipo: z.enum(['FIXO', 'VARIAVEL']),
  categoriaId: z.string().uuid(),
  recorrenciaId: z.string().uuid().optional(),
  grupo: z.enum(GRUPOS).optional(),
  valorCentavos: centavos,
  vencimento: ymd,
  statusPagamento: z.enum(['PENDENTE', 'PAGO', 'CANCELADO']).default('PENDENTE'),
  observacao: z.string().trim().max(1000).optional(),
});

export const atualizarCustoBody = criarCustoBody
  .partial()
  .extend({ recorrenciaId: z.string().uuid().nullable().optional(), grupo: z.enum(GRUPOS).nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

export const criarCategoriaBody = z.object({ nome: z.string().trim().min(2).max(80) });
export const atualizarCategoriaBody = z
  .object({ nome: z.string().trim().min(2).max(80).optional(), ativa: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

export const criarRecorrenciaBody = z
  .object({
    periodicidade: z.enum(['SEMANAL', 'MENSAL', 'TRIMESTRAL', 'ANUAL']),
    inicio: ymd,
    fim: ymd.optional(),
  })
  .refine((v) => !v.fim || v.fim >= v.inicio, { message: '"fim" deve ser posterior a "inicio"', path: ['fim'] });
