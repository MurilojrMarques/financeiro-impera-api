import type { FonteComissao } from '../../../generated/prisma/client';
import { applyBps } from '../../../shared/utils/money';

/** Confiança da fonte: maior substitui menor; igual => a informação mais recente prevalece (correção). */
export const RANK_FONTE_COMISSAO: Record<FonteComissao, number> = {
  HISTORICO_EXATA: 5,
  PAGAH: 4,
  REDTRACK: 3,
  REGRA_AFILIADO: 2,
  ESTIMADA: 1,
  AUSENTE: 0,
};

export interface ComissaoValor {
  centavos: number | null;
  fonte: FonteComissao;
}

/**
 * Mescla comissão existente com a recebida. Retorna o valor que deve ficar no MESMO registro de venda
 * (estimada substituída por confirmada atualiza a venda, nunca cria outra).
 * Valor ausente (null) NÃO é o mesmo que zero: zero explícito é um dado e tem fonte.
 */
export function mesclarComissao(atual: ComissaoValor, nova: ComissaoValor): ComissaoValor {
  if (nova.centavos === null) return atual;
  if (atual.centavos === null) return nova;
  const ra = RANK_FONTE_COMISSAO[atual.fonte];
  const rn = RANK_FONTE_COMISSAO[nova.fonte];
  return rn >= ra ? nova : atual;
}

export interface RegraComissaoVigente {
  valorFixoCentavos: number | null;
  percentualBps: number | null;
  vigenteDe: Date;
  vigenteAte: Date | null;
}

/** Comissão por regra configurada de afiliado (vigência por data de pagamento). */
export function comissaoPorRegra(valorVendaCentavos: number, pagoEm: Date | null, regras: RegraComissaoVigente[]): number | null {
  if (!pagoEm) return null;
  const regra = regras
    .filter((r) => r.vigenteDe <= pagoEm && (!r.vigenteAte || r.vigenteAte > pagoEm))
    .sort((a, b) => b.vigenteDe.getTime() - a.vigenteDe.getTime())[0];
  if (!regra) return null;
  if (regra.valorFixoCentavos !== null) return regra.valorFixoCentavos;
  if (regra.percentualBps !== null) return applyBps(valorVendaCentavos, regra.percentualBps);
  return null;
}
