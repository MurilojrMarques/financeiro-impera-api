import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { lerOrigem, marcaDaOrigem, type EstadoOrigem } from '../../integrations/rh-mysql/rh-mysql';
import { tryAdvisoryLock } from '../../shared/services/db-lock';
import { sanitizeError } from '../../shared/utils/text';
import { recalcularFolhaAbertaDoMes } from './rh.service';
import { registrarSincronizacao, sincronizarRh } from './rh.sync';

/** Lock próprio do RH: não disputa com as sincronizações do financeiro. */
export const RH_SYNC_LOCK_ID = 7_310_002;
const CHAVE_ESTADO = 'rh.sync.estado';

export interface EstadoMonitor {
  ultimaVerificacaoEm: string | null;
  /** marca da origem na última leitura completa (quando e por quem o JSON foi salvo, e o tamanho) */
  marca: { atualizadoEm: string | null; atualizadoPor: string | null; tamanho: number } | null;
  ultimoStatus: 'SUCESSO' | 'ERRO' | null;
  ultimoErro: string | null;
  ultimaSincronizacaoId: string | null;
  ultimoSucessoEm: string | null;
  /** falhas seguidas: o aviso só é gravado na 1ª, na 5ª, na 20ª... para não encher a tabela */
  falhasSeguidas: number;
}

const VAZIO: EstadoMonitor = { ultimaVerificacaoEm: null, marca: null, ultimoStatus: null, ultimoErro: null, ultimaSincronizacaoId: null, ultimoSucessoEm: null, falhasSeguidas: 0 };

export async function lerEstadoMonitor(): Promise<EstadoMonitor> {
  const row = await prisma.configuracaoFinanceira.findUnique({ where: { chave: CHAVE_ESTADO } });
  return { ...VAZIO, ...((row?.valor as Partial<EstadoMonitor> | null) ?? {}) };
}

async function gravarEstado(e: EstadoMonitor): Promise<void> {
  const valor = e as unknown as object;
  await prisma.configuracaoFinanceira.upsert({ where: { chave: CHAVE_ESTADO }, create: { chave: CHAVE_ESTADO, valor }, update: { valor } });
}

export type ResultadoMonitor =
  | { situacao: 'SEM_MUDANCA' }
  | { situacao: 'OCUPADO' }
  | { situacao: 'SINCRONIZADO'; sincronizacaoId: string; alteracoes: number; inconsistencias: number; folhaRecalculada: number }
  | { situacao: 'ERRO'; erro: string };

export interface Leitores {
  marca: typeof marcaDaOrigem;
  ler: () => Promise<EstadoOrigem>;
}

const padrao: Leitores = { marca: marcaDaOrigem, ler: lerOrigem };

/**
 * Um ciclo de monitoramento da origem do RH:
 *  1. pergunta à origem quando o JSON foi salvo pela última vez (consulta barata, sem baixar fotos);
 *  2. se nada mudou, só registra a verificação;
 *  3. se mudou (ou `forcar`), lê tudo, compara, grava e registra cada alteração detectada (salário, cargo, promoção...);
 *  4. se um salário mudou e a folha do mês ainda está aberta, ela acompanha.
 * Seguro contra execuções simultâneas (lock no banco) e contra falhas da origem (registra o erro e tenta de novo no próximo ciclo).
 */
export async function monitorarOrigemRh(gatilho: 'job' | 'manual' | 'script', opts: { forcar?: boolean; leitores?: Leitores } = {}): Promise<ResultadoMonitor> {
  const leitores = opts.leitores ?? padrao;
  const lock = await tryAdvisoryLock(RH_SYNC_LOCK_ID);
  if (!lock) return { situacao: 'OCUPADO' };
  const estado = await lerEstadoMonitor();
  const agora = new Date().toISOString();
  try {
    const marca = await leitores.marca();
    const marcaTexto = { atualizadoEm: marca.atualizadoEm?.toISOString() ?? null, atualizadoPor: marca.atualizadoPor, tamanho: marca.tamanho };
    const igual = estado.marca && estado.marca.atualizadoEm === marcaTexto.atualizadoEm && estado.marca.tamanho === marcaTexto.tamanho && estado.ultimoStatus === 'SUCESSO';
    if (igual && !opts.forcar) {
      await gravarEstado({ ...estado, ultimaVerificacaoEm: agora, ultimoErro: null, falhasSeguidas: 0 });
      return { situacao: 'SEM_MUDANCA' };
    }
    const origem = await leitores.ler();
    const r = await sincronizarRh(origem, { aplicar: true });
    const id = await registrarSincronizacao(gatilho, origem, r, null);
    const folhaRecalculada = await recalcularFolhaAbertaDoMes(r.salarioMudou);
    await gravarEstado({
      ultimaVerificacaoEm: agora,
      marca: { atualizadoEm: origem.atualizadoEm?.toISOString() ?? null, atualizadoPor: origem.atualizadoPor, tamanho: marca.tamanho },
      ultimoStatus: 'SUCESSO',
      ultimoErro: null,
      ultimaSincronizacaoId: id,
      ultimoSucessoEm: agora,
      falhasSeguidas: 0,
    });
    return { situacao: 'SINCRONIZADO', sincronizacaoId: id, alteracoes: r.alteracoes.length, inconsistencias: r.inconsistencias.length, folhaRecalculada };
  } catch (err) {
    const msg = sanitizeError(err);
    const falhas = estado.falhasSeguidas + 1;
    logger.error({ msg, falhasSeguidas: falhas }, 'monitoramento do RH: falha ao ler a origem');
    if (falhas === 1 || falhas % 20 === 0) await registrarSincronizacao(gatilho, { atualizadoEm: null, atualizadoPor: null }, null, err).catch(() => undefined);
    await gravarEstado({ ...estado, ultimaVerificacaoEm: agora, ultimoStatus: 'ERRO', ultimoErro: msg.slice(0, 300), falhasSeguidas: falhas }).catch(() => undefined);
    return { situacao: 'ERRO', erro: msg };
  } finally {
    await lock.release();
  }
}
