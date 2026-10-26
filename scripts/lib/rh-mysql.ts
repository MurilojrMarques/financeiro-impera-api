/** Os scripts usam a mesma conexão somente-leitura da API (src/integrations/rh-mysql). */
import 'dotenv/config';
import type mysql from 'mysql2/promise';
import { comRh as comRhApi } from '../../src/integrations/rh-mysql/rh-mysql';

export const comRh = comRhApi;

/** Estado atual do RH: o JSON da `app_state`. */
export async function lerEstado(db: mysql.Connection): Promise<{ estado: Record<string, unknown>; atualizadoEm: Date | null; atualizadoPor: string | null }> {
  const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT data, updated_at, updated_by FROM app_state ORDER BY id DESC LIMIT 1');
  const r = rows[0];
  if (!r) throw new Error('app_state vazia');
  return { estado: JSON.parse(String(r.data)) as Record<string, unknown>, atualizadoEm: r.updated_at ?? null, atualizadoPor: r.updated_by ?? null };
}
