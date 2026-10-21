export const BUSINESS_TZ = 'America/Sao_Paulo';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallClockInBusinessTz(d: Date): Wall {
  const p: Record<string, number> = {};
  for (const part of partsFmt.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Interpreta um horário "de parede" de São Paulo e devolve o instante UTC correto (considera horário de verão histórico). */
export function businessWallToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let candidate = guess;
  for (let i = 0; i < 3; i++) {
    const w = wallClockInBusinessTz(new Date(candidate));
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const diff = asUtc - guess;
    if (diff === 0) break;
    candidate -= diff;
  }
  return new Date(candidate);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD no fuso de negócio. */
export function businessDateString(d: Date): string {
  const w = wallClockInBusinessTz(d);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * Parse de datas vindas da planilha. Aceita:
 *  - dd/mm/yyyy [HH:mm[:ss]]  (interpretado em America/Sao_Paulo)
 *  - yyyy-mm-dd[ T]HH:mm[:ss] sem offset (interpretado em America/Sao_Paulo)
 *  - ISO com Z/offset explícito (respeitado)
 * Vazio ou inválido => null.
 */
export function parseSheetDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    return validWall(Number(yyyy), Number(mm), Number(dd), Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (m) {
    const [, yyyy, mm, dd, hh, mi, ss] = m;
    return validWall(Number(yyyy), Number(mm), Number(dd), Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0));
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

function validWall(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null; // ex.: 31/02
  return businessWallToUtc(y, mo, d, h, mi, s);
}

/** Início do dia (00:00 SP) para YYYY-MM-DD. */
export function startOfBusinessDay(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return businessWallToUtc(y, m, d, 0, 0, 0);
}

/** Início do dia seguinte (limite exclusivo) para YYYY-MM-DD. */
export function endExclusiveOfBusinessDay(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return businessWallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diffDaysInclusive(de: string, ate: string): number {
  const a = Date.parse(`${de}T00:00:00Z`);
  const b = Date.parse(`${ate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Mês atual (1º dia até hoje) no fuso de negócio. */
export function currentMonthRange(now = new Date()): { de: string; ate: string } {
  const w = wallClockInBusinessTz(now);
  return { de: `${w.year}-${pad(w.month)}-01`, ate: `${w.year}-${pad(w.month)}-${pad(w.day)}` };
}

/** Período anterior de mesma duração, imediatamente antes de `de`. */
export function previousPeriod(de: string, ate: string): { de: string; ate: string } {
  const n = diffDaysInclusive(de, ate);
  return { de: addDaysYmd(de, -n), ate: addDaysYmd(de, -1) };
}
