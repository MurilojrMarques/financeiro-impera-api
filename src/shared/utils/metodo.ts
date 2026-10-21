import { cleanText, searchKey } from './text';

/** Padroniza o método de pagamento (HISTORICO escreve "Cartão", EVENTOS "cartao"). Desconhecido é preservado. */
export function normalizarMetodo(raw: string | null): string | null {
  const s = searchKey(raw);
  if (!s) return null;
  if (/^cartao\b|^(credito|debito)\b/.test(s)) return 'Cartão';
  if (/^pix\b/.test(s)) return 'Pix';
  if (/^boleto\b/.test(s)) return 'Boleto';
  return cleanText(raw);
}
