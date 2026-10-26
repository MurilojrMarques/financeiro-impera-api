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

const campos = {
  nome: texto(160),
  email: z.string().trim().toLowerCase().email().max(254),
  celular: texto(40),
  nascimento: dia,
  cnpj: texto(30),
  endereco: texto(300),
  camiseta: texto(8),
  departamento: texto(100),
  cargoBase: texto(120),
  funcao: texto(160),
  tipoCargo: texto(40),
  senioridade: texto(20),
  subnivel: z.number().int().min(1).max(9),
  gestorId: z.string().uuid(),
  inicio: dia,
  descricao: texto(500),
  obsCargo: texto(500),
  discordUserId: texto(40),
};

export const criarColaboradorBody = z.object({
  nome: campos.nome,
  departamento: campos.departamento,
  salarioCentavos: centavos,
  email: campos.email.optional(),
  celular: campos.celular.optional(),
  nascimento: campos.nascimento.optional(),
  cnpj: campos.cnpj.optional(),
  endereco: campos.endereco.optional(),
  camiseta: campos.camiseta.optional(),
  cargoBase: campos.cargoBase.optional(),
  funcao: campos.funcao.optional(),
  tipoCargo: campos.tipoCargo.optional(),
  senioridade: campos.senioridade.optional(),
  subnivel: campos.subnivel.optional(),
  gestorId: campos.gestorId.optional(),
  inicio: campos.inicio.optional(),
  descricao: campos.descricao.optional(),
  obsCargo: campos.obsCargo.optional(),
  discordUserId: campos.discordUserId.optional(),
});

/** Salário NÃO se altera aqui: use a movimentação (promoção/reajuste), que guarda o histórico. `null` limpa o campo. */
export const atualizarColaboradorBody = z
  .object({
    nome: campos.nome,
    email: campos.email.nullable(),
    celular: campos.celular.nullable(),
    nascimento: campos.nascimento.nullable(),
    cnpj: campos.cnpj.nullable(),
    endereco: campos.endereco.nullable(),
    camiseta: campos.camiseta.nullable(),
    departamento: campos.departamento,
    cargoBase: campos.cargoBase.nullable(),
    funcao: campos.funcao.nullable(),
    tipoCargo: campos.tipoCargo.nullable(),
    senioridade: campos.senioridade.nullable(),
    subnivel: campos.subnivel.nullable(),
    gestorId: campos.gestorId.nullable(),
    inicio: campos.inicio.nullable(),
    demissao: dia.nullable(),
    motivoDemissao: z.enum(['voluntario', 'involuntario']).nullable(),
    descricao: campos.descricao.nullable(),
    obsCargo: campos.obsCargo.nullable(),
    discordUserId: campos.discordUserId.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

export const movimentacaoBody = z.object({
  tipo: z.enum(['PROMOCAO', 'REAJUSTE']),
  data: dia,
  salarioNovoCentavos: centavos,
  cargoNovo: texto(160).optional(),
  departamentoNovo: texto(100).optional(),
  senioridadeNova: texto(20).optional(),
  subnivelNovo: z.number().int().min(1).max(9).optional(),
  obs: texto(500).optional(),
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
