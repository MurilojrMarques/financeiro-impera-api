import { env } from './env';

/** A sincronização automática roda dentro da API (sem processo separado)? */
export const syncAutomaticaAtiva = (): boolean => env.SYNC_ENABLED && env.AUTO_SYNC_ENABLED;

/**
 * Depois de quantos segundos sem sincronizar os dados são "desatualizados". Quem diz é o EVENTOS (a Pagah), que a API lê a cada
 * AUTO_SYNC_EVENTOS_INTERVAL_SECONDS: o aviso só aparece se passar 1,5 × esse intervalo (e nunca menos que STALE_AFTER_SECONDS).
 */
export const limiteDesatualizadoSegundos = (): number =>
  syncAutomaticaAtiva() ? Math.max(env.STALE_AFTER_SECONDS, Math.ceil(env.AUTO_SYNC_EVENTOS_INTERVAL_SECONDS * 1.5)) : env.STALE_AFTER_SECONDS;
