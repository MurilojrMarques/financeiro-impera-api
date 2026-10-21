import { prisma } from '../config/database';
import { env } from '../config/env';
import type { SyncService } from '../modules/sincronizacao/sync.service';
import { businessDateString, wallClockInBusinessTz } from '../shared/utils/dates';

/**
 * Reconciliação completa diária: relê as três abas inteiras (HISTORICO -> EVENTOS -> REDTRACK).
 * Dispara uma vez por dia, a partir do horário configurado (America/Sao_Paulo); sobrevive a reinícios
 * porque consulta a última reconciliação bem-sucedida no banco.
 */
export function reconciliationJob(sync: SyncService, now: () => Date = () => new Date()) {
  return async () => {
    const [hh, mm] = env.SYNC_RECONCILE_TIME.split(':').map(Number);
    const w = wallClockInBusinessTz(now());
    if (w.hour * 60 + w.minute < hh * 60 + mm) return null;

    const hoje = businessDateString(now());
    const ultima = await prisma.sincronizacao.findFirst({
      where: { modo: 'COMPLETA', status: { in: ['SUCESSO', 'PARCIAL'] } },
      orderBy: { iniciadaEm: 'desc' },
      select: { iniciadaEm: true },
    });
    if (ultima && businessDateString(ultima.iniciadaEm) === hoje) return null;
    return sync.executar(['HISTORICO', 'EVENTOS', 'REDTRACK'], 'COMPLETA', 'worker:reconciliacao');
  };
}
