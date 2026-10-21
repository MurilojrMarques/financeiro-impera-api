import { createHash } from 'node:crypto';

/** Remove espaços extras (inclui NBSP) e retorna null para vazio. */
export function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Chave de busca/comparação: sem acento, minúscula, espaços colapsados. */
export function searchKey(raw: unknown): string | null {
  const s = cleanText(raw);
  return s === null ? null : stripAccents(s).toLowerCase();
}

/** Normaliza cabeçalho: "Valor Total" / "valor_total" => "valor_total". */
export function normalizeHeader(raw: unknown): string {
  const s = searchKey(raw) ?? '';
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash estável de um objeto (chaves ordenadas; undefined => null). */
export function stableHash(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const norm = keys.map((k) => [k, normalizeForHash(obj[k])]);
  return sha256(JSON.stringify(norm));
}

function normalizeForHash(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Remove possíveis segredos/dados pessoais de mensagens de erro antes de persistir. */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[chave removida]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/g, '[cpf]')
    .replace(/(bearer|token|secret|password|senha)[=: ]+\S+/gi, '$1=[removido]')
    .slice(0, 500);
}
