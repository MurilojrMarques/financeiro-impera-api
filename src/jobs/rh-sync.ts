import { env } from '../config/env';
import { logger } from '../config/logger';
import { rhConfigurado } from '../integrations/rh-mysql/rh-mysql';
import { monitorarOrigemRh } from '../modules/rh/rh.monitor';
import { sanitizeError } from '../shared/utils/text';
import { Scheduler } from './scheduler';

export interface RhSync {
  parar: () => Promise<void>;
}

/**
 * Monitoramento contínuo do sistema de RH de origem: a cada RH_SYNC_INTERVAL_MINUTES (padrão 5) confere se o JSON foi salvo de novo e, se foi,
 * espelha e registra as alterações (principalmente salário e promoção). Também roda na subida da API.
 */
export function iniciarRhSync(): RhSync | null {
  if (!env.RH_SYNC_ENABLED) {
    logger.info('monitoramento do RH desligado (RH_SYNC_ENABLED=false)');
    return null;
  }
  if (!rhConfigurado()) {
    logger.warn('monitoramento do RH não iniciado: origem não configurada (variáveis RH_* no .env)');
    return null;
  }
  const scheduler = new Scheduler();
  const tarefa = { name: 'rh-monitoramento', intervalMs: env.RH_SYNC_INTERVAL_MINUTES * 60_000, run: async () => {
    const r = await monitorarOrigemRh('job');
    if (r.situacao === 'SINCRONIZADO') logger.info({ alteracoes: r.alteracoes, inconsistencias: r.inconsistencias, folhaRecalculada: r.folhaRecalculada }, 'RH: origem sincronizada');
  } };
  scheduler.add(tarefa);
  const partida = setTimeout(() => {
    void scheduler.runOnce(tarefa).catch((err) => logger.error({ msg: sanitizeError(err) }, 'RH: verificação inicial falhou'));
  }, 20_000);
  partida.unref();
  logger.info({ intervaloMinutos: env.RH_SYNC_INTERVAL_MINUTES }, 'monitoramento do RH ligado');
  return { parar: () => scheduler.stop() };
}
