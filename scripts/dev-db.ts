/**
 * PostgreSQL local descartável (embedded-postgres) para DESENVOLVIMENTO e TESTES quando não há Docker.
 * Não é usado em produção. Uso: `npm run dev:db` (mantém rodando; Ctrl+C encerra).
 */
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.DEV_DB_PORT ?? 54329);
const dataDir = path.resolve(process.env.DEV_DB_DIR ?? '.pgdata');

async function main(): Promise<void> {
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'financeiro', password: 'dev_only_password', port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-collate=C'] });
  const fs = await import('node:fs');
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('financeiro');
  } catch {
    // já existe
  }
  console.log(`PostgreSQL de desenvolvimento em postgresql://financeiro:dev_only_password@localhost:${port}/financeiro`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
