import type { SyncService } from '../modules/sincronizacao/sync.service';

export const syncRedtrackJob = (sync: SyncService) => () => sync.executar(['REDTRACK'], 'INCREMENTAL', 'worker');
