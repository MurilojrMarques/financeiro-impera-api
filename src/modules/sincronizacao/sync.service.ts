import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { FonteDadoTipo, Prisma, StatusSincronizacao } from '../../generated/prisma/client';
import type { ColumnMap, TabKey } from '../../integrations/google-sheets/google-sheets.mapper';
import {
  GoogleSheetsService,
  SheetsIntegrationError,
  type ParsedBatch,
  type ParseIssue,
} from '../../integrations/google-sheets/google-sheets.service';
import type { EventoRow, HistoricoRow, RedtrackRow } from '../../integrations/google-sheets/google-sheets.schemas';
import { AppError } from '../../shared/errors/app-error';
import { tryAdvisoryLock, SYNC_LOCK_ID } from '../../shared/services/db-lock';
import { sanitizeError, stableHash } from '../../shared/utils/text';
import { mesclarComissao } from '../vendas/domain/comissao';
import type { Fato } from '../vendas/domain/venda.aggregator';
import { isCriterioX1 } from '../vendas/domain/x1';
import { eventoParaFato, historicoParaFato, type FatoErro, type FatoPedido, type ResultadoFato } from './fatos';
import { carregarVendas, persistirFatos, type ContextoPersistencia } from './venda.persistence';

export type ModoSync = 'INCREMENTAL' | 'COMPLETA' | 'INICIAL';

export interface ResumoSync {
  fonte: FonteDadoTipo;
  sincronizacaoId: string;
  status: StatusSincronizacao;
  lidos: number;
  inseridos: number;
  atualizados: number;
  ignorados: number;
  comErro: number;
  duracaoMs: number;
  erro?: string;
}

export class SyncBusyError extends AppError {
  constructor() {
    super(409, 'SYNC_EM_ANDAMENTO', 'Já existe uma sincronização em andamento');
  }
}

interface Contadores {
  lidos: number;
  inseridos: number;
  atualizados: number;
  ignorados: number;
  comErro: number;
}

const TAB_DA_FONTE: Record<FonteDadoTipo, TabKey> = { HISTORICO: 'HISTORICO', EVENTOS: 'EVENTOS', REDTRACK: 'REDTRACK' };
const INTERVALO_FONTE: Record<FonteDadoTipo, () => number> = {
  EVENTOS: () => env.SYNC_EVENTOS_INTERVAL_SECONDS,
  REDTRACK: () => env.SYNC_REDTRACK_INTERVAL_SECONDS,
  HISTORICO: () => 86_400,
};

export interface SyncOptions {
  batchSize?: number;
  lookbackRows?: number;
}

export class SyncService {
  private readonly batchSize: number;
  private readonly lookback: number;

  constructor(
    private readonly sheets: GoogleSheetsService,
    opts: SyncOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? env.SHEETS_BATCH_SIZE;
    this.lookback = opts.lookbackRows ?? env.SYNC_LOOKBACK_ROWS;
  }

  /**
   * Executa as fontes em sequência sob UM lock consultivo do PostgreSQL.
   * Falha em uma fonte não apaga dados já sincronizados e não impede o registro das demais.
   */
  async executar(fontes: FonteDadoTipo[], modo: ModoSync, disparadoPor = 'worker'): Promise<ResumoSync[]> {
    return (await this.iniciar(fontes, modo, disparadoPor)).concluida;
  }

  /**
   * Adquire o lock e inicia a execução. Lança SyncBusyError imediatamente se outra instância já sincroniza;
   * caso contrário devolve a promise da execução (permite responder 202 na API sem esperar o fim).
   */
  async iniciar(fontes: FonteDadoTipo[], modo: ModoSync, disparadoPor = 'worker'): Promise<{ concluida: Promise<ResumoSync[]> }> {
    const lock = await tryAdvisoryLock(SYNC_LOCK_ID);
    if (!lock) throw new SyncBusyError();
    const concluida = (async () => {
      try {
        const resultados: ResumoSync[] = [];
        for (const fonte of fontes) resultados.push(await this.executarFonte(fonte, modo, disparadoPor));
        return resultados;
      } finally {
        await lock.release();
      }
    })();
    return { concluida };
  }

  private async executarFonte(fonte: FonteDadoTipo, modo: ModoSync, disparadoPor: string): Promise<ResumoSync> {
    const inicio = Date.now();
    await prisma.fonteDados.upsert({
      where: { tipo: fonte },
      create: { tipo: fonte, nomeAba: this.sheets.tabName(TAB_DA_FONTE[fonte]), intervaloSegundos: INTERVALO_FONTE[fonte]() },
      update: { nomeAba: this.sheets.tabName(TAB_DA_FONTE[fonte]), intervaloSegundos: INTERVALO_FONTE[fonte](), ultimaLeituraEm: new Date() },
    });
    const sinc = await prisma.sincronizacao.create({ data: { fonte, modo, disparadaPor: disparadoPor } });
    const c: Contadores = { lidos: 0, inseridos: 0, atualizados: 0, ignorados: 0, comErro: 0 };

    try {
      const map = await this.sheets.validateTab(TAB_DA_FONTE[fonte]);
      const cursor = await prisma.sincronizacaoCursor.findUnique({ where: { fonte } });
      const cabecalhoMudou = !!cursor?.assinaturaCab && cursor.assinaturaCab !== map.assinatura;
      if (cabecalhoMudou) logger.warn({ fonte }, 'cabeçalhos da planilha mudaram: releitura completa');
      await prisma.fonteDados.update({
        where: { tipo: fonte },
        data: { cabecalhos: map.cabecalhosNormalizados, cabecalhosAusentes: map.ausentesOpcionais },
      });

      const completa = modo !== 'INCREMENTAL' || cabecalhoMudou || fonte === 'REDTRACK' || !cursor;
      let proxima = completa ? 1 : Math.max(1, cursor.ultimaLinha - this.lookback + 1);
      const ctx = await this.contexto();

      for (;;) {
        const lote = await this.lerLote(fonte, map, proxima);
        const parcial = await this.processarLote(fonte, map, lote, proxima, ctx, sinc.id, modo !== 'INCREMENTAL');
        c.lidos += lote.lidas;
        c.inseridos += parcial.inseridos;
        c.atualizados += parcial.atualizados;
        c.ignorados += parcial.ignorados + lote.vazias;
        c.comErro += parcial.comErro;
        if (lote.lidas < this.batchSize) break;
        proxima = lote.ultimaLinha + 1;
      }

      const status: StatusSincronizacao = c.comErro > 0 ? 'PARCIAL' : 'SUCESSO';
      await this.finalizar(sinc.id, fonte, status, c, inicio, null);
      return { fonte, sincronizacaoId: sinc.id, status, ...c, duracaoMs: Date.now() - inicio };
    } catch (err) {
      const msg = sanitizeError(err);
      const estado = err instanceof SheetsIntegrationError ? err.codigo : 'ERRO';
      logger.error({ fonte, codigo: estado, msg }, 'falha na sincronização');
      await this.finalizar(sinc.id, fonte, 'FALHA', c, inicio, msg, estado);
      return { fonte, sincronizacaoId: sinc.id, status: 'FALHA', ...c, duracaoMs: Date.now() - inicio, erro: msg };
    }
  }

  private lerLote(fonte: FonteDadoTipo, map: ColumnMap, start: number): Promise<ParsedBatch<EventoRow | HistoricoRow | RedtrackRow>> {
    return this.sheets.readBatch(TAB_DA_FONTE[fonte], map, start, this.batchSize) as Promise<
      ParsedBatch<EventoRow | HistoricoRow | RedtrackRow>
    >;
  }

  private async contexto(): Promise<ContextoPersistencia & { redtrackPayoutComoComissao: boolean }> {
    const [regras, x1, rt] = await Promise.all([
      prisma.regraClassificacao.findMany({ where: { ativa: true } }),
      prisma.configuracaoFinanceira.findUnique({ where: { chave: 'x1.criterio' } }),
      prisma.configuracaoFinanceira.findUnique({ where: { chave: 'redtrack.payoutComoComissao' } }),
    ]);
    return {
      regras,
      x1: x1 && isCriterioX1(x1.valor) ? x1.valor : null,
      // Doc Pagah 16/10: o payout do RedTrack é a comissão exata. Ligado por padrão; `false` explícito desliga.
      redtrackPayoutComoComissao: rt?.valor !== false,
    };
  }

  /** Persiste o lote e AVANÇA o cursor na MESMA transação: cursor nunca passa de dados não gravados. */
  private async processarLote(
    fonte: FonteDadoTipo,
    map: ColumnMap,
    lote: ParsedBatch<EventoRow | HistoricoRow | RedtrackRow>,
    startRow: number,
    ctx: ContextoPersistencia & { redtrackPayoutComoComissao: boolean },
    sincId: string,
    reprocessar: boolean,
  ): Promise<Omit<Contadores, 'lidos'>> {
    const sincErros: Prisma.ErroImportacaoCreateManyInput[] = lote.invalid.map((i) => erroInput(fonte, i));
    const resumo = { inseridos: 0, atualizados: 0, ignorados: 0, comErro: new Set(lote.invalid.map((i) => i.linha)).size };

    await prisma.$transaction(
      async (tx) => {
        if (fonte === 'REDTRACK') {
          const r = await this.processarRedtrack(tx, lote.valid as { linha: number; data: RedtrackRow }[], ctx.redtrackPayoutComoComissao);
          resumo.inseridos += r.inseridos;
          resumo.atualizados += r.atualizados;
          resumo.ignorados += r.ignorados;
        } else {
          const pedidos = [...new Set(lote.valid.map((v) => (v.data as EventoRow | HistoricoRow).pedido))];
          const existentes = new Map((await carregarVendas(tx, pedidos)).map((v) => [v.pedido, v]));
          const fatos: FatoPedido[] = [];
          for (const row of lote.valid) {
            const res: ResultadoFato =
              fonte === 'EVENTOS'
                ? eventoParaFato(row.data as EventoRow, row.linha, existentes.get((row.data as EventoRow).pedido)?.valorVendaCentavos ?? null)
                : historicoParaFato(row.data as HistoricoRow, row.linha);
            if ('ok' in res) fatos.push(res.ok);
            else if ('ignorado' in res) resumo.ignorados++;
            else {
              resumo.comErro++;
              sincErros.push(erroInput(fonte, { ...res.erro } as ParseIssue));
            }
          }

          // registros já importados e idênticos (mesma chave + hash) não são reprocessados
          const registros = await tx.registroImportado.findMany({
            where: { fonte, chave: { in: fatos.map((f) => f.chaveRegistro) } },
            select: { chave: true, hash: true },
          });
          const hashes = new Map(registros.map((r) => [r.chave, r.hash]));
          // Incremental pula registros idênticos. A reconciliação COMPLETA reprocessa tudo: assim mudanças nas regras de
          // domínio chegam aos dados já importados (a escrita só ocorre se o estado final da venda mudar de fato).
          const novos = reprocessar ? fatos : fatos.filter((f) => hashes.get(f.chaveRegistro) !== f.hashRegistro);
          resumo.ignorados += fatos.length - novos.length;

          const porPedido = new Map<string, Fato[]>();
          novos.forEach((f) => porPedido.set(f.pedido, [...(porPedido.get(f.pedido) ?? []), f.fato]));
          const r = await persistirFatos(tx, porPedido, existentes, ctx);
          resumo.inseridos += r.inseridos;
          resumo.atualizados += r.atualizados;
          resumo.ignorados += r.ignorados;

          for (const f of novos) {
            await tx.registroImportado.upsert({
              where: { fonte_chave: { fonte, chave: f.chaveRegistro } },
              create: { fonte, chave: f.chaveRegistro, hash: f.hashRegistro, linhaOrigem: f.linha },
              update: { hash: f.hashRegistro, linhaOrigem: f.linha },
            });
          }
        }

        if (sincErros.length > 0) {
          // mesma linha/código/campo já registrado não é duplicado a cada ciclo de releitura
          const jaExistem = await tx.erroImportacao.findMany({
            where: { fonte, linhaOrigem: { in: sincErros.map((e) => e.linhaOrigem as number) } },
            select: { linhaOrigem: true, codigo: true, campo: true },
          });
          const vistos = new Set(jaExistem.map((e) => `${e.linhaOrigem}|${e.codigo}|${e.campo}`));
          const novosErros = sincErros.filter((e) => !vistos.has(`${e.linhaOrigem}|${e.codigo}|${e.campo}`));
          if (novosErros.length > 0) await tx.erroImportacao.createMany({ data: novosErros.map((e) => ({ ...e, sincronizacaoId: sincId })) });
        }
        if (lote.lidas > 0) {
          const ultima = startRow + lote.lidas - 1;
          const atual = await tx.sincronizacaoCursor.findUnique({ where: { fonte } });
          await tx.sincronizacaoCursor.upsert({
            where: { fonte },
            create: { fonte, ultimaLinha: ultima, assinaturaCab: map.assinatura },
            update: { ultimaLinha: Math.max(atual?.ultimaLinha ?? 0, ultima), assinaturaCab: map.assinatura },
          });
        }
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
    return resumo;
  }

  private async processarRedtrack(
    tx: Prisma.TransactionClient,
    rows: { linha: number; data: RedtrackRow }[],
    payoutComoComissao: boolean,
  ): Promise<{ inseridos: number; atualizados: number; ignorados: number }> {
    const out = { inseridos: 0, atualizados: 0, ignorados: 0 };
    // última ocorrência de cada pedido no lote vence
    const porPedido = new Map<string, { linha: number; data: RedtrackRow }>();
    rows.forEach((r) => porPedido.set(r.data.pedido, r));
    const pedidos = [...porPedido.keys()];
    const [existentes, vendas] = await Promise.all([
      tx.redtrackConversao.findMany({ where: { pedido: { in: pedidos } } }),
      tx.venda.findMany({
        where: { pedido: { in: pedidos } },
        select: { id: true, pedido: true, campanha: true, anuncio: true, comissaoCentavos: true, comissaoFonte: true },
      }),
    ]);
    const exMap = new Map(existentes.map((e) => [e.pedido, e]));
    const vMap = new Map(vendas.map((v) => [v.pedido, v]));

    for (const [pedido, { linha, data }] of porPedido) {
      const hash = stableHash(data as unknown as Record<string, unknown>);
      const ex = exMap.get(pedido);
      const venda = vMap.get(pedido);
      // comissão resultante da troca estimada -> payout (se habilitada); calculada antes para decidir se há o que gravar
      const merged =
        venda && payoutComoComissao && data.payout !== null
          ? mesclarComissao({ centavos: venda.comissaoCentavos, fonte: venda.comissaoFonte }, { centavos: data.payout, fonte: 'REDTRACK' })
          : null;
      const comissaoMudaria = !!merged && (merged.centavos !== venda!.comissaoCentavos || merged.fonte !== venda!.comissaoFonte);
      if (ex && ex.hashConteudo === hash && ex.vendaId === (venda?.id ?? null) && !comissaoMudaria) {
        out.ignorados++;
        continue;
      }
      const payload = {
        vendaId: venda?.id ?? null,
        conversaoId: data.conversao,
        payoutCentavos: data.payout,
        situacao: data.situacao,
        campanha: data.campanha,
        anuncio: data.anuncio,
        hashConteudo: hash,
        linhaOrigem: linha,
        sincronizadoEm: new Date(),
      };
      await tx.redtrackConversao.upsert({ where: { pedido }, create: { pedido, ...payload }, update: payload });
      if (ex) out.atualizados++;
      else out.inseridos++;

      if (venda) {
        const patch: Prisma.VendaUpdateInput = { redtrackConciliado: true };
        if (!venda.campanha && data.campanha) patch.campanha = data.campanha;
        if (!venda.anuncio && data.anuncio) patch.anuncio = data.anuncio;
        if (merged) {
          patch.comissaoCentavos = merged.centavos;
          patch.comissaoFonte = merged.fonte;
        }
        await tx.venda.update({ where: { id: venda.id }, data: patch });
      }
    }
    return out;
  }

  private async finalizar(
    id: string,
    fonte: FonteDadoTipo,
    status: StatusSincronizacao,
    c: Contadores,
    inicio: number,
    erro: string | null,
    estadoErro = 'ERRO',
  ): Promise<void> {
    const agora = new Date();
    await prisma.sincronizacao.update({
      where: { id },
      data: { status, finalizadaEm: agora, duracaoMs: agora.getTime() - inicio, ...c, erro },
    });
    const ok = status === 'SUCESSO' || status === 'PARCIAL';
    await prisma.fonteDados.update({
      where: { tipo: fonte },
      data: ok
        ? { ultimoSucessoEm: agora, ultimaLeituraEm: agora, estado: status === 'PARCIAL' ? 'ATUALIZADA_COM_ERROS' : 'ATUALIZADA', ultimoErro: null }
        : { ultimaLeituraEm: agora, estado: estadoErro, ultimoErro: erro },
    });
  }
}

function erroInput(fonte: FonteDadoTipo, e: FatoErro | ParseIssue): Prisma.ErroImportacaoCreateManyInput {
  return {
    fonte,
    linhaOrigem: e.linha,
    codigo: e.codigo,
    campo: e.campo,
    mensagem: 'mensagem' in e ? e.mensagem : '',
  };
}
