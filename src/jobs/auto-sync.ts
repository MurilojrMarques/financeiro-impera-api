import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { syncAutomaticaAtiva } from '../config/sync-policy';
import { aquecerInvestimento } from '../integrations/redtrack/redtrack.client';
import { GoogleSheetsClient } from '../integrations/google-sheets/google-sheets.client';
import { GoogleSheetsService } from '../integrations/google-sheets/google-sheets.service';
import { SyncBusyError, SyncService, type ResumoSync } from '../modules/sincronizacao/sync.service';
import type { FonteDadoTipo } from '../generated/prisma/client';
import { sanitizeError } from '../shared/utils/text';
import { reconciliationJob } from './reconciliation.job';
import { Scheduler } from './scheduler';

export interface EstadoSyncAutomatica {
  ativa: boolean;
  intervaloMinutos: number;
  proximaEm: Date | null;
  ultimaTentativaEm: Date | null;
  ultimoResultado: 'SUCESSO' | 'ERRO' | 'OCUPADO' | null;
  /** leitura frequente da Pagah (EVENTOS) */
  eventosIntervaloSegundos: number;
  eventosUltimaEm: Date | null;
  eventosUltimoResultado: 'SUCESSO' | 'ERRO' | 'OCUPADO' | null;
}

/** Estado exposto em /integracoes/sheets/status (a tela "Integrações" mostra a próxima execução automática). */
export const estadoSyncAutomatica: EstadoSyncAutomatica = {
  ativa: false,
  intervaloMinutos: env.AUTO_SYNC_INTERVAL_MINUTES,
  proximaEm: null,
  ultimaTentativaEm: null,
  ultimoResultado: null,
  eventosIntervaloSegundos: env.AUTO_SYNC_EVENTOS_INTERVAL_SECONDS,
  eventosUltimaEm: null,
  eventosUltimoResultado: null,
};

type Executor = Pick<SyncService, 'executar'>;

const temSucesso = async (fonte: FonteDadoTipo): Promise<boolean> =>
  !!(await prisma.sincronizacao.findFirst({ where: { fonte, status: { in: ['SUCESSO', 'PARCIAL'] } }, select: { id: true } }));

/**
 * Um ciclo automático:
 *  1. fontes que NUNCA tiveram sucesso fazem a importação INICIAL (HISTORICO → EVENTOS → REDTRACK);
 *  2. EVENTOS e REDTRACK rodam em modo INCREMENTAL (o HISTORICO é um retrato mensal: só entra na reconciliação diária).
 * Respeita o lock do banco: se alguém (ou o worker) já está sincronizando, o ciclo é adiado sem erro.
 */
export async function cicloAutomatico(sync: Executor): Promise<ResumoSync[]> {
  const resultados: ResumoSync[] = [];
  const pendentes: FonteDadoTipo[] = [];
  for (const f of ['HISTORICO', 'EVENTOS', 'REDTRACK'] as const) if (!(await temSucesso(f))) pendentes.push(f);
  if (pendentes.length > 0) resultados.push(...(await sync.executar(pendentes, 'INICIAL', 'auto:inicial')));
  const incrementais = (['EVENTOS', 'REDTRACK'] as const).filter((f) => !pendentes.includes(f));
  if (incrementais.length > 0) resultados.push(...(await sync.executar(incrementais, 'INCREMENTAL', 'auto')));
  return resultados;
}

/**
 * Leitura frequente da Pagah: só o EVENTOS, em modo INCREMENTAL (o que chegou desde a última leitura). Não faz a importação inicial
 * (isso é do ciclo completo) nem mexe no RedTrack. Devolve null quando o EVENTOS ainda não teve sucesso.
 */
export async function cicloEventos(sync: Executor): Promise<ResumoSync | null> {
  if (!(await temSucesso('EVENTOS'))) return null;
  const [r] = await sync.executar(['EVENTOS'], 'INCREMENTAL', 'auto:eventos');
  return r ?? null;
}

/** Mantém as estatísticas do planner em dia (depois de cargas grandes o Postgres pode escolher planos ruins) e aquece o cache do RedTrack. */
export async function manutencaoPosSync(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe('ANALYZE vendas');
    await prisma.$executeRawUnsafe('ANALYZE venda_eventos');
  } catch (err) {
    logger.warn({ msg: sanitizeError(err) }, 'ANALYZE pós-sincronização falhou');
  }
  await aquecerInvestimento().catch((err) => logger.warn({ msg: sanitizeError(err) }, 'aquecimento do RedTrack falhou'));
}

async function executarCiclo(sync: Executor): Promise<void> {
  estadoSyncAutomatica.ultimaTentativaEm = new Date();
  try {
    const r = await cicloAutomatico(sync);
    await manutencaoPosSync();
    estadoSyncAutomatica.ultimoResultado = r.some((x) => x.status === 'FALHA') ? 'ERRO' : 'SUCESSO';
    logger.info({ fontes: r.map((x) => ({ fonte: x.fonte, status: x.status, lidos: x.lidos, atualizados: x.atualizados, inseridos: x.inseridos })) }, 'sincronização automática concluída');
  } catch (err) {
    if (err instanceof SyncBusyError) {
      estadoSyncAutomatica.ultimoResultado = 'OCUPADO';
      logger.info('sincronização automática adiada: já há uma em andamento');
      return;
    }
    estadoSyncAutomatica.ultimoResultado = 'ERRO';
    logger.error({ msg: sanitizeError(err) }, 'sincronização automática falhou');
  }
}

async function executarCicloEventos(sync: Executor): Promise<void> {
  estadoSyncAutomatica.eventosUltimaEm = new Date();
  try {
    const r = await cicloEventos(sync);
    estadoSyncAutomatica.eventosUltimoResultado = !r || r.status !== 'FALHA' ? 'SUCESSO' : 'ERRO';
    // depois de uma carga grande o planner precisa de estatísticas novas; nas leituras pequenas isso seria desperdício
    if (r && r.inseridos + r.atualizados > 1000) await manutencaoPosSync();
    if (r && r.inseridos + r.atualizados > 0) logger.info({ lidos: r.lidos, inseridos: r.inseridos, atualizados: r.atualizados }, 'Pagah: novos eventos sincronizados');
  } catch (err) {
    if (err instanceof SyncBusyError) {
      estadoSyncAutomatica.eventosUltimoResultado = 'OCUPADO';
      return;
    }
    estadoSyncAutomatica.eventosUltimoResultado = 'ERRO';
    logger.error({ msg: sanitizeError(err) }, 'leitura frequente da Pagah falhou');
  }
}

export interface SyncAutomatica {
  parar: () => Promise<void>;
}

/**
 * Liga a sincronização automática: ciclo completo a cada AUTO_SYNC_INTERVAL_MINUTES (padrão 60; RedTrack) + leitura da Pagah a cada AUTO_SYNC_EVENTOS_INTERVAL_SECONDS (padrão 120) e, na subida da API, se a última tiver sido há mais
 * tempo que o intervalo (a máquina pode ter ficado desligada). Também faz a reconciliação completa diária (SYNC_RECONCILE_TIME).
 * A sincronização manual da tela "Integrações" continua disponível e usa o mesmo lock.
 */
export function iniciarSyncAutomatica(): SyncAutomatica | null {
  if (!syncAutomaticaAtiva()) {
    logger.info('sincronização automática desligada (SYNC_ENABLED/AUTO_SYNC_ENABLED)');
    return null;
  }
  let sync: SyncService;
  try {
    sync = new SyncService(new GoogleSheetsService(new GoogleSheetsClient()));
  } catch (err) {
    logger.warn({ msg: sanitizeError(err) }, 'sincronização automática não iniciada: integração com o Google Sheets não configurada');
    return null;
  }

  const intervaloMs = env.AUTO_SYNC_INTERVAL_MINUTES * 60_000;
  const scheduler = new Scheduler();
  const agendarProxima = (): void => {
    estadoSyncAutomatica.proximaEm = new Date(Date.now() + intervaloMs);
  };

  estadoSyncAutomatica.ativa = true;
  estadoSyncAutomatica.intervaloMinutos = env.AUTO_SYNC_INTERVAL_MINUTES;
  agendarProxima();

  scheduler.add({
    name: 'sync-automatica',
    intervalMs: intervaloMs,
    run: async () => {
      agendarProxima();
      await executarCiclo(sync);
    },
  });
  // Pagah quase em tempo real: lê só o que chegou de novo (RedTrack continua no ciclo completo acima)
  scheduler.add({ name: 'sync-eventos-automatica', intervalMs: env.AUTO_SYNC_EVENTOS_INTERVAL_SECONDS * 1000, run: () => executarCicloEventos(sync) });
  scheduler.add({ name: 'reconciliacao-diaria', intervalMs: 5 * 60_000, run: reconciliationJob(sync) });

  // atualização imediata na subida se os dados estiverem velhos (ou nunca sincronizados)
  const partida = setTimeout(() => {
    void (async () => {
      const ultimo = await prisma.fonteDados.findFirst({ where: { tipo: 'EVENTOS' }, select: { ultimoSucessoEm: true } });
      const velho = !ultimo?.ultimoSucessoEm || Date.now() - ultimo.ultimoSucessoEm.getTime() > intervaloMs;
      if (velho) {
        agendarProxima();
        await scheduler.runOnce({ name: 'sync-automatica', intervalMs: intervaloMs, run: () => executarCiclo(sync) });
      } else {
        await manutencaoPosSync(); // dados em dia: só aquece o cache do RedTrack e atualiza as estatísticas do banco
      }
    })().catch((err) => logger.error({ msg: sanitizeError(err) }, 'verificação inicial da sincronização automática falhou'));
  }, env.AUTO_SYNC_STARTUP_DELAY_SECONDS * 1000);
  partida.unref();

  logger.info({ intervaloMinutos: env.AUTO_SYNC_INTERVAL_MINUTES, eventosSegundos: env.AUTO_SYNC_EVENTOS_INTERVAL_SECONDS, reconciliacao: env.SYNC_RECONCILE_TIME }, 'sincronização automática ligada');
  return {
    parar: async () => {
      clearTimeout(partida);
      estadoSyncAutomatica.ativa = false;
      estadoSyncAutomatica.proximaEm = null;
      await scheduler.stop();
    },
  };
}
