import { checkDatabase, closeDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/database';
import { GoogleSheetsClient } from './integrations/google-sheets/google-sheets.client';
import { GoogleSheetsService } from './integrations/google-sheets/google-sheets.service';
import { reconciliationJob } from './jobs/reconciliation.job';
import { Scheduler } from './jobs/scheduler';
import { syncEventosJob } from './jobs/sync-eventos.job';
import { syncHistoricoJob } from './jobs/sync-historico.job';
import { syncRedtrackJob } from './jobs/sync-redtrack.job';
import { SyncService } from './modules/sincronizacao/sync.service';
import type { FonteDadoTipo } from './generated/prisma/client';
import { sanitizeError } from './shared/utils/text';

/** Primeira inicialização: valida banco e Google, depois importação inicial controlada das fontes ainda sem sucesso. */
async function primeiraInicializacao(sync: SyncService, sheets: GoogleSheetsService): Promise<void> {
  if (!(await checkDatabase())) throw new Error('PostgreSQL indisponível');
  try {
    await sheets.validateAll();
  } catch (err) {
    // Não derruba o worker: os ciclos seguintes tentam de novo e o estado fica visível em /integracoes/sheets/status.
    logger.error({ msg: sanitizeError(err) }, 'validação inicial do Google Sheets falhou');
    return;
  }
  const ordem: FonteDadoTipo[] = ['HISTORICO', 'EVENTOS', 'REDTRACK'];
  const pendentes: FonteDadoTipo[] = [];
  for (const fonte of ordem) {
    const ok = await prisma.sincronizacao.findFirst({ where: { fonte, status: { in: ['SUCESSO', 'PARCIAL'] } } });
    if (!ok) pendentes.push(fonte);
  }
  if (pendentes.length > 0) {
    logger.info({ pendentes }, 'importação inicial');
    await sync.executar(pendentes, 'INICIAL', 'worker:inicial');
  }
}

async function main(): Promise<void> {
  if (!env.SYNC_ENABLED) {
    logger.warn('SYNC_ENABLED=false: worker não iniciado');
    await closeDatabase();
    return;
  }
  const sheets = new GoogleSheetsService(new GoogleSheetsClient());
  const sync = new SyncService(sheets);
  const scheduler = new Scheduler();

  await primeiraInicializacao(sync, sheets).catch((err) => logger.error({ msg: sanitizeError(err) }, 'inicialização do worker falhou'));

  scheduler.add({ name: 'sync-eventos', intervalMs: env.SYNC_EVENTOS_INTERVAL_SECONDS * 1000, run: syncEventosJob(sync) });
  scheduler.add({ name: 'sync-redtrack', intervalMs: env.SYNC_REDTRACK_INTERVAL_SECONDS * 1000, run: syncRedtrackJob(sync) });
  scheduler.add({ name: 'sync-historico', intervalMs: 3_600_000, run: syncHistoricoJob(sync) });
  scheduler.add({ name: 'reconciliacao', intervalMs: 60_000, run: reconciliationJob(sync) });
  logger.info('worker de sincronização iniciado');

  let encerrando = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    logger.info({ signal }, 'encerrando worker');
    await scheduler.stop();
    await closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ msg: sanitizeError(err) }, 'worker falhou ao iniciar');
  process.exit(1);
});
