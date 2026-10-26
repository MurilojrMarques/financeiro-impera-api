/**
 * Conexão SOMENTE LEITURA com o MySQL do sistema de RH atual (VPS), por túnel SSH. Variáveis RH_* no `.env`.
 * `comRh(fn)` abre o túnel, executa `fn(db)` e fecha tudo. A sessão é aberta em modo READ ONLY.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import mysql from 'mysql2/promise';
import { Client } from 'ssh2';

const need = (k: string): string => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`Defina ${k} no .env`);
  return v;
};

function abrirTunel(): Promise<{ ssh: Client; stream: Duplex }> {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    const fingerprint = process.env.RH_SSH_HOST_FINGERPRINT?.trim();
    ssh
      .on('ready', () => {
        ssh.forwardOut('127.0.0.1', 0, process.env.RH_MYSQL_HOST?.trim() || '127.0.0.1', Number(process.env.RH_MYSQL_PORT ?? 3306), (err, stream) => {
          if (err) {
            ssh.end();
            reject(err);
          } else resolve({ ssh, stream });
        });
      })
      .on('error', reject)
      .connect({
        host: need('RH_SSH_HOST'),
        port: Number(process.env.RH_SSH_PORT ?? 22),
        username: need('RH_SSH_USER'),
        ...(process.env.RH_SSH_KEY_PATH ? { privateKey: readFileSync(process.env.RH_SSH_KEY_PATH), passphrase: process.env.RH_SSH_KEY_PASSPHRASE } : { password: need('RH_SSH_PASSWORD') }),
        readyTimeout: 20_000,
        hostHash: 'sha256',
        hostVerifier: (hash: string) => {
          if (!fingerprint) {
            console.log(`(primeira conexão) impressão digital SHA256 do servidor: ${hash} — guarde em RH_SSH_HOST_FINGERPRINT (hex) para travar`);
            return true;
          }
          return hash === fingerprint;
        },
      });
  });
}

export async function comRh<T>(fn: (db: mysql.Connection) => Promise<T>): Promise<T> {
  const { ssh, stream } = await abrirTunel();
  const db = await mysql.createConnection({
    user: need('RH_MYSQL_USER'),
    password: need('RH_MYSQL_PASSWORD'),
    database: process.env.RH_MYSQL_DATABASE?.trim() || 'impera_rh',
    stream,
  });
  try {
    await db.query('SET SESSION TRANSACTION READ ONLY');
    return await fn(db);
  } finally {
    await db.end();
    ssh.end();
  }
}

/** Estado atual do RH: o JSON da `app_state` (id 1). */
export async function lerEstado(db: mysql.Connection): Promise<{ estado: Record<string, unknown>; atualizadoEm: Date | null; atualizadoPor: string | null }> {
  const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT data, updated_at, updated_by FROM app_state ORDER BY id DESC LIMIT 1');
  const r = rows[0];
  if (!r) throw new Error('app_state vazia');
  return { estado: JSON.parse(String(r.data)) as Record<string, unknown>, atualizadoEm: r.updated_at ?? null, atualizadoPor: r.updated_by ?? null };
}
