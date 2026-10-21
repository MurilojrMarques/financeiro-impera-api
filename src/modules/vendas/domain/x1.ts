import { searchKey } from '../../../shared/utils/text';
import type { Atributos } from './venda.aggregator';

/**
 * Identificação de vendas X1 (comissão = 0 nos relatórios padrão; o valor real fica guardado).
 * Critério em ConfiguracaoFinanceira (chave `x1.criterio`); sem configuração, nenhuma venda é X1.
 *
 * Regra decidida (doc Pagah 16/10/2026): "Pix sem valor líquido do vendedor 889739 (Pedro)":
 *   { "todas": [
 *       { "campo": "METODO",      "operador": "IGUAL", "valor": "pix" },
 *       { "campo": "VENDEDOR_ID", "operador": "IGUAL", "valor": "889739" },
 *       { "campo": "LIQUIDO",     "operador": "IGUAL", "valor": "VAZIO" } ] }
 * Condição única também é aceita: { "campo": "...", "operador": "...", "valor": "..." }.
 */
export const CAMPOS_X1 = ['LOJA', 'CHECKOUT', 'PRODUTO', 'ORIGEM', 'TIPO', 'METODO', 'VENDEDOR_ID', 'LIQUIDO'] as const;
export const OPERADORES_X1 = ['IGUAL', 'CONTEM', 'COMECA_COM'] as const;

export interface CondicaoX1 {
  campo: (typeof CAMPOS_X1)[number];
  operador: (typeof OPERADORES_X1)[number];
  /** LIQUIDO usa o valor "VAZIO" (valor líquido ausente ou zero) ou "PREENCHIDO" */
  valor: string;
}
export type CriterioX1 = CondicaoX1 | { todas: CondicaoX1[] };

function isCondicao(v: unknown): v is CondicaoX1 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (CAMPOS_X1 as readonly string[]).includes(o.campo as string) &&
    (OPERADORES_X1 as readonly string[]).includes(o.operador as string) &&
    typeof o.valor === 'string' &&
    o.valor.trim() !== ''
  );
}

export function isCriterioX1(v: unknown): v is CriterioX1 {
  if (isCondicao(v)) return true;
  const todas = (v as { todas?: unknown } | null)?.todas;
  return Array.isArray(todas) && todas.length > 0 && todas.every(isCondicao);
}

function condicaoAtende(a: Atributos, c: CondicaoX1): boolean {
  if (c.campo === 'LIQUIDO') {
    const vazio = a.valorLiquidoCentavos === null || a.valorLiquidoCentavos === 0;
    return searchKey(c.valor) === 'vazio' ? vazio : !vazio;
  }
  const campos: Record<Exclude<CondicaoX1['campo'], 'LIQUIDO'>, string | null> = {
    LOJA: a.loja,
    CHECKOUT: a.checkout,
    PRODUTO: a.produto,
    ORIGEM: a.origem,
    TIPO: a.tipoBruto,
    METODO: a.metodo,
    VENDEDOR_ID: a.vendedorId,
  };
  const atual = searchKey(campos[c.campo]);
  const alvo = searchKey(c.valor);
  if (atual === null || alvo === null) return false;
  if (c.operador === 'IGUAL') return atual === alvo;
  if (c.operador === 'CONTEM') return atual.includes(alvo);
  return atual.startsWith(alvo);
}

export function ehX1(a: Atributos, criterio: CriterioX1 | null): boolean {
  if (!criterio) return false;
  const condicoes = 'todas' in criterio ? criterio.todas : [criterio];
  return condicoes.every((c) => condicaoAtende(a, c));
}
