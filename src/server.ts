import type { Server } from 'node:http';
import { createApp } from './app';
import { checkDatabase, closeDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { iniciarSyncAutomatica } from './jobs/auto-sync';
import { iniciarRhSync } from './jobs/rh-sync';

async function main(): Promise<void> {
  if (!(await checkDatabase())) {
    logger.fatal('PostgreSQL indisponível na inicialização');
    process.exit(1);
  }
  const app = createApp();
  const server: Server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API iniciada'));
  server.requestTimeout = 60_000;
  const syncAuto = iniciarSyncAutomatica();
  const rhSync = iniciarRhSync();
  server.headersTimeout = 30_000;

  let encerrando = false;
  const shutdown = (signal: string): void => {
    if (encerrando) return;
    encerrando = true;
    logger.info({ signal }, 'encerrando API');
    // para de aceitar conexões, aguarda as em andamento e fecha o banco
    void Promise.allSettled([syncAuto?.parar(), rhSync?.parar()]).finally(() =>
      server.close(() => {
        closeDatabase().finally(() => process.exit(0));
      }),
    );
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'falha ao iniciar a API');
  process.exit(1);
});
