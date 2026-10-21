/**
 * Valores monetários: centavos inteiros. Nunca usar float em cálculo.
 * O parse é feito por manipulação de string (sem Number() sobre decimais).
 */

/** Converte texto monetário (BR ou US) para centavos. Vazio/ilegível => null (≠ zero). */
export function parseMoneyToCents(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw * 100);
  }
  let s = String(raw).trim();
  if (s === '' || s === '-') return null;
  s = s.replace(/R\$\s*/gi, '').replace(/\s/g, '');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;

  // Regras: o último separador é o decimal, exceto quando há só pontos
  // e eles seguem o padrão de milhar BR ("1.234" ou "1.234.567").
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const onlyDots = lastComma === -1 && lastDot !== -1;
  const dotsAreThousands = onlyDots && /^\d{1,3}(\.\d{3})+$/.test(s);
  let intPart: string;
  let fracPart = '';
  const decimalPos = dotsAreThousands ? -1 : Math.max(lastComma, lastDot);
  if (decimalPos === -1) {
    intPart = s.replace(/[.,]/g, '');
  } else {
    intPart = s.slice(0, decimalPos).replace(/[.,]/g, '');
    fracPart = s.slice(decimalPos + 1);
  }
  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  const frac = (fracPart + '00').slice(0, 2);
  // arredonda pelo terceiro dígito, se houver
  const third = fracPart.length > 2 ? Number(fracPart[2]) : 0;
  let cents = Number(intPart) * 100 + Number(frac) + (third >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) return null;
  if (negative) cents = -cents;
  return cents;
}

export function centsToReais(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = Math.trunc(abs / 100);
  const c = String(abs % 100).padStart(2, '0');
  return `${sign}${reais}.${c}`;
}

/** Divisão inteira com arredondamento (meio para cima) — para ticket médio. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round(numerator / denominator);
}

/** Aplica pontos-base (1% = 100 bps) em centavos, com arredondamento. */
export function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10000);
}
