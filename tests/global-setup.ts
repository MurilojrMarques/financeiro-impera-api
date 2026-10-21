import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Sobe um PostgreSQL real e descartável (porta 54330), aplica as migrations de verdade (`prisma migrate deploy`)
 * e expõe DATABASE_URL aos testes. Se TEST_DATABASE_URL existir, usa esse banco (CI com Postgres de serviço).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const externo = process.env.TEST_DATABASE_URL;
  let pg: EmbeddedPostgres | null = null;
  let dir: string | null = null;
  let url: string;

  if (externo) {
    url = externo;
  } else {
    dir = mkdtempSync(path.join(tmpdir(), 'financeiro-pg-'));
    const port = 54330;
    pg = new EmbeddedPostgres({
      databaseDir: path.join(dir, 'data'), user: 'test', password: 'test', port, persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-collate=C'],
    });
    if (!existsSync(path.join(dir, 'data', 'PG_VERSION'))) await pg.initialise();
    await pg.start();
    await pg.createDatabase('test');
    url = `postgresql://test:test@127.0.0.1:${port}/test?schema=public`;
  }

  process.env.DATABASE_URL = url;
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });

  return async () => {
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
