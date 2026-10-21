import { prisma } from '../config/database';
import type { SyncService } from '../modules/sincronizacao/sync.service';

/** HISTORICO: importado na primeira execução (ou se nunca teve sucesso); depois só na reconciliação. */
export function syncHistoricoJob(sync: SyncService) {
  return async () => {
    const jaImportado = await prisma.sincronizacao.findFirst({ where: { fonte: 'HISTORICO', status: { in: ['SUCESSO', 'PARCIAL'] } } });
    if (jaImportado) return null;
    return sync.executar(['HISTORICO'], 'INICIAL', 'worker');
  };
}
