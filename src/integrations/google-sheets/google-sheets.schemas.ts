import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FonteComissao, TipoEvento } from '../../generated/prisma/client';
import { parseMoneyToCents } from '../../shared/utils/money';
import { parseSheetDate } from '../../shared/utils/dates';
import { cleanText, searchKey } from '../../shared/utils/text';

/** Vazio => null. Datas inválidas viram erro de validação (não somem em silêncio). */
const text = z.string().nullable().transform((v) => cleanText(v));

const pedido = z
  .string()
  .nullable()
  .transform((v) => {
    const s = cleanText(v);
    return s === null ? null : s.replace(/\.0+$/, '');
  })
  .refine((v): v is string => v !== null, 'pedido ausente');

const money = (field: string) =>
  z
    .string()
    .nullable()
    .transform((v, ctx) => {
      if (cleanText(v) === null) return null;
      const cents = parseMoneyToCents(v);
      if (cents === null) {
        ctx.addIssue({ code: 'custom', message: `valor monetário inválido em ${field}` });
        return z.NEVER;
      }
      return cents;
    });

const date = (field: string) =>
  z
    .string()
    .nullable()
    .transform((v, ctx) => {
      if (cleanText(v) === null) return null;
      const d = parseSheetDate(v);
      if (!d) {
        ctx.addIssue({ code: 'custom', message: `data inválida em ${field}` });
        return z.NEVER;
      }
      return d;
    });

const truthy = z
  .string()
  .nullable()
  .transform((v) => ['true', '1', 'sim', 'yes', 'x', 'verdadeiro'].includes(searchKey(v) ?? ''));

const int = z
  .string()
  .nullable()
  .transform((v) => {
    const s = cleanText(v);
    if (s === null) return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : null;
  });

export type TipoPerdaOuPagamento = TipoEvento;

export function mapTipoEvento(raw: string | null): TipoEvento | null {
  const s = searchKey(raw);
  if (!s) return null;
  if (s.includes('charge')) return 'CHARGEBACK';
  if (s.includes('estorn') || s.includes('refund') || s.includes('reembols')) return 'ESTORNO';
  if (s.includes('pag') || s.includes('paid') || s.includes('aprov') || s.includes('approved')) return 'PAGAMENTO';
  return null;
}

export function mapFonteComissao(raw: string | null): { fonte: FonteComissao; reconhecida: boolean } {
  const s = searchKey(raw);
  if (!s) return { fonte: 'PAGAH', reconhecida: false };
  if (s.includes('estim')) return { fonte: 'ESTIMADA', reconhecida: true };
  if (s.includes('hist')) return { fonte: 'HISTORICO_EXATA', reconhecida: true };
  if (s.includes('redtrack')) return { fonte: 'REDTRACK', reconhecida: true };
  if (s.includes('pagah') || s.includes('webhook') || s.includes('payload')) return { fonte: 'PAGAH', reconhecida: true };
  return { fonte: 'ESTIMADA', reconhecida: false }; // desconhecida => confiança mínima
}

/**
 * A coluna de payload do EVENTOS pode conter chaves de dados pessoais. NUNCA guardamos o JSON: ele é lido em memória
 * e só `id_user_venda` (id do vendedor/operador, sem dado pessoal) é extraído; todo o resto é descartado aqui mesmo.
 */
export function extrairVendedorDoPayload(raw: string | null): { vendedorId: string | null } {
  return { vendedorId: extrairDoPayload(raw).vendedorId };
}

/**
 * Do payload sai só o que não é dado pessoal: `id_user_venda` e `valor_taxa_callcenter` (a taxa de 20% do Call Center, já calculada pela
 * Pagah, em centavos). Ausente/inválido = null (ausente não é zero; zero explícito é um dado).
 */
export function extrairDoPayload(raw: string | null): { vendedorId: string | null; taxaCallCenterCentavos: number | null } {
  const vazio = { vendedorId: null, taxaCallCenterCentavos: null };
  const s = cleanText(raw);
  if (!s) return vazio;
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const v = j.id_user_venda;
    const id = v === undefined || v === null ? '' : String(v).trim();
    const t = j.valor_taxa_callcenter;
    const taxa = t === undefined || t === null || t === '' ? NaN : Number(t);
    return {
      vendedorId: /^[\w-]{1,40}$/.test(id) && id !== '0' ? id : null,
      taxaCallCenterCentavos: Number.isFinite(taxa) && taxa >= 0 ? Math.round(taxa) : null,
    };
  } catch {
    return vazio;
  }
}

export { normalizarMetodo } from '../../shared/utils/metodo';

/** O id do cliente nunca é guardado: só o hash, suficiente para saber que dois pedidos são da mesma pessoa. */
export function hashCliente(raw: string | null): string | null {
  const s = cleanText(raw);
  return s ? createHash('sha256').update(`cliente:${s}`).digest('hex').slice(0, 32) : null;
}

export const eventoRowSchema = z.object({
  payload: z.string().nullable().transform(extrairDoPayload),
  pedido,
  evento: text,
  recebido_em: date('recebido_em'),
  pago_em: date('pago_em'),
  tipo: text,
  cliente_id: text.transform(hashCliente),
  afiliado: text,
  loja: text,
  checkout: text,
  produto: text,
  valor_total: money('valor_total'),
  valor_sem_juros: money('valor_sem_juros'),
  valor_liquido: money('valor_liquido'),
  comissao: money('comissao'),
  comissao_fonte: text,
  metodo: text,
  parcelas: int,
  utm_source: text,
  utm_campaign: text,
  utm_content: text,
  src: text,
  teste: truthy,
  canal: text,
  subcanal: text,
  origem_lead: text,
});
export type EventoRow = z.infer<typeof eventoRowSchema>;

export const historicoRowSchema = z.object({
  pedido,
  status: text,
  data_criacao: date('data_criacao'),
  data_pagamento: date('data_pagamento'),
  data_estorno: date('data_estorno'),
  tipo: text,
  origem: text,
  tipo_atendimento: text,
  atendente: text,
  loja: text,
  produto: text,
  metodo: text,
  valor_total: money('valor_total'),
  valor_sem_juros: money('valor_sem_juros'),
  juros: money('juros'),
  comissao: money('comissao'),
  taxa_call_center: money('taxa_call_center'),
  comissao_afiliado: money('comissao_afiliado'),
  campanha: text,
  click_id: text,
  afiliado: text,
});
export type HistoricoRow = z.infer<typeof historicoRowSchema>;

export const redtrackRowSchema = z.object({
  pedido,
  conversao: text,
  payout: money('payout'),
  situacao: text,
  campanha: text,
  anuncio: text,
});
export type RedtrackRow = z.infer<typeof redtrackRowSchema>;
