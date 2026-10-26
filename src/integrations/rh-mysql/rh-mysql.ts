/**
 * Conexão SOMENTE LEITURA com o MySQL do sistema de RH (VPS), por túnel SSH. A sessão é aberta em modo READ ONLY e só há consultas SELECT:
 * esta API nunca grava no sistema de origem.
 */
import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import mysql from 'mysql2/promise';
import { Client } from 'ssh2';
import { env } from '../../config/env';

export const rhConfigurado = (): boolean =>
  !!(env.RH_SSH_HOST && env.RH_SSH_USER && (env.RH_SSH_PASSWORD || env.RH_SSH_KEY_PATH) && env.RH_MYSQL_USER && env.RH_MYSQL_PASSWORD);

function abrirTunel(): Promise<{ ssh: Client; stream: Duplex }> {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    ssh
      .on('ready', () => {
        ssh.forwardOut('127.0.0.1', 0, env.RH_MYSQL_HOST, env.RH_MYSQL_PORT, (err, stream) => {
          if (err) {
            ssh.end();
            reject(err);
          } else resolve({ ssh, stream });
        });
      })
      .on('error', reject)
      .connect({
        host: env.RH_SSH_HOST!,
        port: env.RH_SSH_PORT,
        username: env.RH_SSH_USER!,
        ...(env.RH_SSH_KEY_PATH ? { privateKey: readFileSync(env.RH_SSH_KEY_PATH), passphrase: env.RH_SSH_KEY_PASSPHRASE } : { password: env.RH_SSH_PASSWORD! }),
        readyTimeout: 20_000,
        hostHash: 'sha256',
        hostVerifier: (hash: string) => {
          // com a impressão digital configurada, recusa qualquer servidor diferente (proteção contra interceptação)
          if (!env.RH_SSH_HOST_FINGERPRINT) return true;
          return hash === env.RH_SSH_HOST_FINGERPRINT;
        },
      });
  });
}

export async function comRh<T>(fn: (db: mysql.Connection) => Promise<T>): Promise<T> {
  if (!rhConfigurado()) throw new Error('Origem do RH não configurada (variáveis RH_* no .env)');
  const { ssh, stream } = await abrirTunel();
  const db = await mysql.createConnection({ user: env.RH_MYSQL_USER!, password: env.RH_MYSQL_PASSWORD!, database: env.RH_MYSQL_DATABASE, stream });
  try {
    await db.query('SET SESSION TRANSACTION READ ONLY');
    return await fn(db);
  } finally {
    await db.end().catch(() => undefined);
    ssh.end();
  }
}

export interface EstadoOrigem {
  estado: Record<string, unknown>;
  atualizadoEm: Date | null;
  atualizadoPor: string | null;
  admins: { id: number; username: string; email: string | null; role: string; departamento: string | null; colaborador_id: string | null }[];
}

/** Consulta barata: quando e por quem o JSON foi salvo pela última vez e o tamanho dele (sem baixar o JSON, que carrega as fotos). */
export async function marcaDaOrigem(): Promise<{ atualizadoEm: Date | null; atualizadoPor: string | null; tamanho: number }> {
  return comRh(async (db) => {
    const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT updated_at, updated_by, CHAR_LENGTH(data) AS tam FROM app_state ORDER BY id DESC LIMIT 1');
    const r = rows[0];
    if (!r) throw new Error('app_state vazia na origem');
    return { atualizadoEm: r.updated_at ?? null, atualizadoPor: r.updated_by ?? null, tamanho: Number(r.tam) };
  });
}

/** Lê o estado completo (JSON da app_state) e os usuários da origem. */
export async function lerOrigem(): Promise<EstadoOrigem> {
  return comRh(async (db) => {
    const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT data, updated_at, updated_by FROM app_state ORDER BY id DESC LIMIT 1');
    const r = rows[0];
    if (!r) throw new Error('app_state vazia na origem');
    const [admins] = await db.query<mysql.RowDataPacket[]>('SELECT id, username, email, role, departamento, colaborador_id FROM admin_users');
    return {
      estado: JSON.parse(String(r.data)) as Record<string, unknown>,
      atualizadoEm: r.updated_at ?? null,
      atualizadoPor: r.updated_by ?? null,
      admins: admins as EstadoOrigem['admins'],
    };
  });
}
