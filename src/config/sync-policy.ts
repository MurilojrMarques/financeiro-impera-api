import { env } from './env';

/** A sincronização automática roda dentro da API (sem processo separado)? */
export const syncAutomaticaAtiva = (): boolean => env.SYNC_ENABLED && env.AUTO_SYNC_ENABLED;

/**
 * Depois de quantos segundos sem sincronizar os dados são "desatualizados". Com a sincronização automática de N minutos, o aviso só
 * aparece se passar 1,5 × N (senão toda hora entre uma execução e outra mostraria "desatualizado" sem haver problema).
 */
export const limiteDesatualizadoSegundos = (): number =>
  syncAutomaticaAtiva() ? Math.max(env.STALE_AFTER_SECONDS, Math.ceil(env.AUTO_SYNC_INTERVAL_MINUTES * 60 * 1.5)) : env.STALE_AFTER_SECONDS;
