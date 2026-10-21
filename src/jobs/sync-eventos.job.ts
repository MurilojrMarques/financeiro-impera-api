import type { SyncService } from '../modules/sincronizacao/sync.service';

export const syncEventosJob = (sync: SyncService) => () => sync.executar(['EVENTOS'], 'INCREMENTAL', 'worker');
