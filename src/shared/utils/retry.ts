export interface RetryOptions {
  retries: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Backoff exponencial com "full jitter": delay = random(0, min(max, base * 2^n)). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retries, baseMs = 500, maxMs = 30_000, isRetryable = () => true, sleep = defaultSleep, random = Math.random } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/** Erros transitórios da Google API: 429, 5xx e falhas de rede/timeout. */
export function isTransientGoogleError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const status = e.response?.status ?? e.status ?? (typeof e.code === 'number' ? e.code : undefined);
  if (status !== undefined) return status === 429 || status === 408 || status >= 500;
  const code = typeof e.code === 'string' ? e.code : '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(code);
}
