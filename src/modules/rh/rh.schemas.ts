import { z } from 'zod';

export const idParams = z.object({ id: z.string().uuid() });
const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use o formato AAAA-MM-DD')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'data inválida');
export const competenciaSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use o formato AAAA-MM');
export const competenciaParams = z.object({ competencia: competenciaSchema });
export const itemParams = z.object({ competencia: competenciaSchema, itemId: z.string().uuid() });

const texto = (max: number) => z.string().trim().min(1).max(max);
const centavos = z.number().int().min(0).max(100_000_000_00);

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  busca: z.string().trim().max(100).optional(),
  departamento: z.string().trim().max(100).optional(),
  gestorId: z.string().uuid().optional(),
  ativo: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const folhaItemBody = z
  .object({
    comissaoCentavos: centavos,
    bonusCentavos: centavos,
    descontoCentavos: centavos,
    obs: z.string().trim().max(500).nullable(),
    status: z.enum(['PENDENTE', 'PAGO']),
    pagoEm: dia.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

export const docListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  colaboradorId: z.string().uuid().optional(),
  competencia: competenciaSchema.optional(),
  tipo: z.enum(['NOTA_FISCAL', 'COMPROVANTE_PAGAMENTO', 'CONTRATO', 'OUTRO']).optional(),
  status: z.enum(['ENVIADO', 'APROVADO', 'REPROVADO']).optional(),
});

export const docResumoQuery = z.object({ competencia: competenciaSchema });
export const comissaoQuery = z.object({ competencia: competenciaSchema });
export const comissaoVinculoBody = z.object({ copywriterId: z.string().uuid(), colaboradorId: z.string().uuid().nullable() });
export const comissaoLancarBody = z.object({ competencia: competenciaSchema });

export const docUploadBody = z.object({
  tipo: z.enum(['NOTA_FISCAL', 'COMPROVANTE_PAGAMENTO', 'CONTRATO', 'OUTRO']),
  colaboradorId: z.string().uuid().optional(),
  competencia: competenciaSchema.optional(),
  valorCentavos: z.coerce.number().int().min(0).max(100_000_000_00).optional(),
  descricao: z.string().trim().max(300).optional(),
});

export const docStatusBody = z
  .object({ status: z.enum(['APROVADO', 'REPROVADO']), motivo: z.string().trim().min(3).max(300).optional() })
  .refine((v) => v.status !== 'REPROVADO' || !!v.motivo, { message: 'Informe o motivo da reprovação', path: ['motivo'] });
