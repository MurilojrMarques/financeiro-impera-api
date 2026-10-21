import { Client } from 'pg';
import { env } from '../../config/env';

export interface AdvisoryLock {
  release(): Promise<void>;
}

/**
 * Lock consultivo do PostgreSQL (nível de SESSÃO) em conexão dedicada.
 * - Funciona entre processos/instâncias (não depende de variável em memória).
 * - Se o processo morrer, a conexão cai e o lock é liberado automaticamente.
 * Retorna null se outro processo já detém o lock.
 */
export async function tryAdvisoryLock(lockId: number): Promise<AdvisoryLock | null> {
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  client.on('error', () => undefined); // erro após o connect não deve derrubar o processo
  await client.connect();
  try {
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [lockId]);
    if (!res.rows[0]?.ok) {
      await client.end();
      return null;
    }
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return {
    async release() {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

/** Lock global das sincronizações (HISTORICO/EVENTOS/REDTRACK compartilham as mesmas vendas). */
export const SYNC_LOCK_ID = 7_310_001;
