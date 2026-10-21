import { z } from 'zod';
import { normalizarMetodo } from '../utils/metodo';
import {
  addDaysYmd,
  currentMonthRange,
  diffDaysInclusive,
  endExclusiveOfBusinessDay,
  previousPeriod,
  startOfBusinessDay,
} from '../utils/dates';

export const MAX_PERIODO_DIAS = 366;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use o formato AAAA-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, 'data inválida');

export const GRUPOS = ['FRONT', 'BACKEND_OUTROS', 'CALL_CENTER', 'RECUPERACAO', 'AFILIADO', 'NAO_CLASSIFICADA'] as const;
export const STATUS = ['PAGO', 'ESTORNADO', 'CHARGEBACK', 'PENDENTE_CONCILIACAO'] as const;
export const CRITERIOS = ['APROVADAS', 'MOVIMENTACAO'] as const;

/** Filtros padronizados aceitos pelos endpoints de consulta (seção 11 do escopo). */
export const filtrosBase = z.object({
  de: ymd.optional(),
  ate: ymd.optional(),
  loja: z.string().trim().min(1).max(120).optional(),
  produto: z.string().trim().min(1).max(200).optional(),
  grupo: z.enum(GRUPOS).optional(),
  afiliadoId: z.string().uuid().optional(),
  metodo: z.string().trim().min(1).max(60).optional(),
  status: z.enum(STATUS).optional(),
  origem: z.string().trim().min(1).max(120).optional(),
  campanha: z.string().trim().min(1).max(200).optional(),
  anuncio: z.string().trim().min(1).max(200).optional(),
  tipo: z.enum(['FRONT', 'UPSELL', 'DOWNSELL', 'COMPRA']).optional(),
  modo: z.enum(CRITERIOS).default('MOVIMENTACAO'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  sortOrder: z.enum(['ASC', 'DESC']).default('DESC'),
  sortBy: z.string().max(40).optional(),
  incluirX1: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export type FiltrosQuery = z.infer<typeof filtrosBase>;

/** Refinamento de período reutilizável por qualquer schema de consulta que contenha de/ate. */
export function refinarPeriodo(v: { de?: string; ate?: string }, ctx: z.RefinementCtx): void {
  const { de, ate } = periodoPadrao(v);
  if (de > ate) ctx.addIssue({ code: 'custom', path: ['de'], message: '"de" deve ser anterior ou igual a "ate"' });
  else if (diffDaysInclusive(de, ate) > MAX_PERIODO_DIAS) {
    ctx.addIssue({ code: 'custom', path: ['ate'], message: `período máximo de ${MAX_PERIODO_DIAS} dias` });
  }
}

/** Schema com refinamentos de período. Usado como `validate({ query: filtrosSchema })`. */
export const filtrosSchema = filtrosBase.superRefine(refinarPeriodo);

function periodoPadrao(v: { de?: string; ate?: string }): { de: string; ate: string } {
  const mes = currentMonthRange();
  return { de: v.de ?? mes.de, ate: v.ate ?? v.de ?? mes.ate };
}

export interface FiltroResolvido extends Omit<FiltrosQuery, 'de' | 'ate'> {
  de: string;
  ate: string;
  /** [deTs, ateTsExcl) em UTC, fronteiras à meia-noite de America/Sao_Paulo */
  deTs: Date;
  ateTsExcl: Date;
}

export function resolverFiltro(q: FiltrosQuery): FiltroResolvido {
  const { de, ate } = periodoPadrao(q);
  // o método é guardado padronizado (Cartão/Pix/Boleto); o filtro aceita qualquer grafia (cartao, CARTÃO...)
  const metodo = q.metodo ? (normalizarMetodo(q.metodo) ?? q.metodo) : undefined;
  return { ...q, metodo, de, ate, deTs: startOfBusinessDay(de), ateTsExcl: endExclusiveOfBusinessDay(ate) };
}

/** Mesmo filtro deslocado para o período anterior de mesma duração. */
export function filtroAnterior(f: FiltroResolvido): FiltroResolvido {
  const p = previousPeriod(f.de, f.ate);
  return { ...f, de: p.de, ate: p.ate, deTs: startOfBusinessDay(p.de), ateTsExcl: endExclusiveOfBusinessDay(p.ate) };
}

/** Valida ordenação contra whitelist; devolve a coluna segura ou o padrão. */
export function ordenacaoSegura<T extends string>(sortBy: string | undefined, permitidos: readonly T[], padrao: T): T {
  return sortBy && (permitidos as readonly string[]).includes(sortBy) ? (sortBy as T) : padrao;
}

export const idUuidParams = z.object({ id: z.string().uuid() });
export const pedidoParams = z.object({ pedido: z.string().trim().min(1).max(60) });

export { addDaysYmd };
