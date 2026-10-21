import type { Request, RequestHandler, Response } from 'express';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import {
  alertasQualidade,
  porDimensao,
  serie,
  ticketMedio,
  totais,
  type Bucket,
  type Dimensao,
  type Metricas,
} from '../repositories/ledger.repository';
import { BUSINESS_TZ } from '../utils/dates';
import { ok, pageMeta, paginated } from '../utils/response';
import { filtroAnterior, resolverFiltro, type FiltroResolvido, type FiltrosQuery } from '../validators/filtros';

export interface Alerta {
  codigo: string;
  severidade: 'info' | 'aviso' | 'critico';
  mensagem: string;
  quantidade?: number;
}

export interface MetaFinanceira {
  periodo: { de: string; ate: string };
  timezone: string;
  criterioFinanceiro: FiltroResolvido['modo'];
  metodologia: string;
  ultimaSincronizacao: string | null;
  dadosDesatualizados: boolean;
  [k: string]: unknown;
}

const METODOLOGIA: Record<FiltroResolvido['modo'], string> = {
  APROVADAS:
    'Vendas aprovadas: pedidos pagos no período pelo STATUS ATUAL (valor_sem_juros menos perda atual do pedido). Aproxima o painel Pagah.',
  MOVIMENTACAO:
    'Movimentação financeira: pagamentos do período menos perdas (estorno/chargeback) reconhecidas na data do evento de perda. Perda integral de um pedido é contada uma única vez.',
};

export async function ultimaSincronizacaoEventos(): Promise<{ em: Date | null; desatualizado: boolean }> {
  const fonte = await prisma.fonteDados.findUnique({ where: { tipo: 'EVENTOS' }, select: { ultimoSucessoEm: true } });
  const em = fonte?.ultimoSucessoEm ?? null;
  const desatualizado = !em || Date.now() - em.getTime() > env.STALE_AFTER_SECONDS * 1000;
  return { em, desatualizado };
}

export async function metaFinanceira(f: FiltroResolvido, extra: Record<string, unknown> = {}): Promise<MetaFinanceira> {
  const sync = await ultimaSincronizacaoEventos();
  return {
    periodo: { de: f.de, ate: f.ate },
    timezone: BUSINESS_TZ,
    criterioFinanceiro: f.modo,
    metodologia: METODOLOGIA[f.modo],
    ultimaSincronizacao: sync.em?.toISOString() ?? null,
    dadosDesatualizados: sync.desatualizado,
    ...extra,
  };
}

export interface MetricasFormatadas extends Metricas {
  ticketMedioCentavos: number;
}

export function formatar(m: Metricas, modo: FiltroResolvido['modo']): MetricasFormatadas {
  return { ...m, ticketMedioCentavos: ticketMedio(m, modo) };
}

/** Alertas sobre dados estimados, ausentes ou conciliação incompleta. Nunca esconde limitações. */
export async function construirAlertas(f: FiltroResolvido, m: Metricas): Promise<Alerta[]> {
  const q = await alertasQualidade(f);
  const alertas: Alerta[] = [];
  if (m.comissaoEstimadaCentavos > 0) {
    alertas.push({ codigo: 'COMISSAO_ESTIMADA', severidade: 'aviso', mensagem: 'O total de comissão inclui valores estimados por regra configurada.' });
  }
  if (m.comissaoAfiliadoEstimadaCentavos > 0) {
    alertas.push({ codigo: 'COMISSAO_AFILIADO_ESTIMADA', severidade: 'aviso', mensagem: 'Parte da comissão de afiliados vem de regra configurada (valor estimado), não da fonte.' });
  }
  if (m.pedidosSemComissao > 0) {
    alertas.push({
      codigo: 'COMISSAO_AUSENTE',
      severidade: 'aviso',
      mensagem: 'Há pedidos sem comissão informada; eles não entram no total de comissão.',
      quantidade: m.pedidosSemComissao,
    });
  }
  if (q.naoClassificadas > 0) {
    alertas.push({ codigo: 'RECEITA_NAO_CLASSIFICADA', severidade: 'aviso', mensagem: 'Há vendas sem origem identificável (NAO_CLASSIFICADA).', quantidade: q.naoClassificadas });
  }
  if (q.pendentesConciliacao > 0) {
    alertas.push({ codigo: 'PENDENTE_CONCILIACAO', severidade: 'aviso', mensagem: 'Há pedidos sem data de pagamento, fora das visões por data.', quantidade: q.pendentesConciliacao });
  }
  if (q.semDataEstorno > 0) {
    alertas.push({ codigo: 'PERDA_SEM_DATA', severidade: 'aviso', mensagem: 'Há estornos/chargebacks sem data: não entram na movimentação por data do evento.', quantidade: q.semDataEstorno });
  }
  alertas.push({
    codigo: 'REEMBOLSO_PIX_LIMITACAO',
    severidade: 'info',
    mensagem: 'Alguns reembolsos de Pix não chegam pelo webhook Pagah e não são conhecidos por esta API; nada é estimado.',
  });
  alertas.push({ codigo: 'UNIDADES_INDISPONIVEIS', severidade: 'info', mensagem: 'Unidades vendidas não existem na planilha e não são presumidas.' });
  return alertas;
}

/** Handler padrão de relatório: filtros validados -> dados + meta financeira. */
export function relatorio<T>(
  build: (f: FiltroResolvido, req: Request) => Promise<T>,
  ajuste?: (f: FiltroResolvido, req: Request) => FiltroResolvido,
): RequestHandler {
  return async (req: Request, res: Response) => {
    let f = resolverFiltro(req.valid.query as FiltrosQuery);
    if (ajuste) f = ajuste(f, req);
    const data = await build(f, req);
    ok(res, data, await metaFinanceira(f));
  };
}

/** Handler padrão de lista paginada. `build` devolve itens e total. */
export function lista<T>(
  build: (f: FiltroResolvido, req: Request) => Promise<{ items: T[]; total: number }>,
  ajuste?: (f: FiltroResolvido, req: Request) => FiltroResolvido,
): RequestHandler {
  return async (req: Request, res: Response) => {
    let f = resolverFiltro(req.valid.query as FiltrosQuery);
    if (ajuste) f = ajuste(f, req);
    const { items, total } = await build(f, req);
    paginated(res, items, pageMeta(f.page, f.limit, total), await metaFinanceira(f));
  };
}

type Ajuste = (f: FiltroResolvido, req: Request) => FiltroResolvido;

/** Resumo: totais formatados + alertas de qualidade. */
export const resumoHandler = (ajuste?: Ajuste) =>
  relatorio(async (f) => {
    const m = await totais(f);
    return { ...formatar(m, f.modo), alertas: await construirAlertas(f, m) };
  }, ajuste);

export const dimensaoHandler = (dim: Dimensao, ajuste?: Ajuste) =>
  relatorio(async (f) => (await porDimensao(f, dim)).map(({ chave, id, ...m }) => ({ chave, ...(id ? { id } : {}), ...formatar(m, f.modo) })), ajuste);

export const serieHandler = (bucket: Bucket, ajuste?: Ajuste) =>
  relatorio(async (f) => (await serie(f, bucket)).map(({ periodo, ...m }) => ({ periodo, ...formatar(m, f.modo) })), ajuste);

export const comparativoHandler = (ajuste?: Ajuste) => relatorio((f) => comparativo(f), ajuste);

/** Força o grupo de receita do módulo (o parâmetro `grupo` do cliente é ignorado nesses módulos). */
export const forcarGrupo =
  (grupo: NonNullable<FiltroResolvido['grupo']>): Ajuste =>
  (f) => ({ ...f, grupo });

/** Métricas do período e do período anterior de mesma duração, com variação. */
export async function comparativo(f: FiltroResolvido) {
  const anterior = filtroAnterior(f);
  const [atual, ant] = await Promise.all([totais(f), totais(anterior)]);
  const variacao = (a: number, b: number): number | null => (b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 10000) / 100);
  return {
    atual: { periodo: { de: f.de, ate: f.ate }, ...formatar(atual, f.modo) },
    anterior: { periodo: { de: anterior.de, ate: anterior.ate }, ...formatar(ant, f.modo) },
    variacaoPercentual: {
      receita: variacao(atual.receitaCentavos, ant.receitaCentavos),
      pedidos: variacao(atual.pedidos, ant.pedidos),
      comissao: variacao(atual.comissaoCentavos, ant.comissaoCentavos),
      estornos: variacao(atual.estornosCentavos, ant.estornosCentavos),
      chargebacks: variacao(atual.chargebacksCentavos, ant.chargebacksCentavos),
    },
  };
}

