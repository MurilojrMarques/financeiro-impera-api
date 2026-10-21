import { prisma } from '../../config/database';
import { porDimensao, totais, type Metricas } from '../../shared/repositories/ledger.repository';
import { addDaysYmd, businessDateString, endExclusiveOfBusinessDay, startOfBusinessDay } from '../../shared/utils/dates';
import { filtroAnterior, type FiltroResolvido } from '../../shared/validators/filtros';
import {
  custosDeRegras,
  ocorrenciasNoPeriodo,
  type BaseGrupo,
  type LancamentoBase,
  type OcorrenciaCusto,
  type RegraCustoInput,
} from './custos.calc';

const ymdToUtc = (s: string) => new Date(`${s}T00:00:00Z`);

export interface CustosPeriodo {
  totalCentavos: number;
  lancamentosCentavos: number;
  regrasCentavos: number;
  porCategoria: { categoriaId: string | null; categoria: string; totalCentavos: number }[];
  porGrupo: { grupo: string; totalCentavos: number }[];
  ocorrencias: OcorrenciaCusto[];
  regras: { itens: ReturnType<typeof custosDeRegras>['itens']; indisponiveis: ReturnType<typeof custosDeRegras>['indisponiveis'] };
  metodologia: string;
}

const SEM_CATEGORIA = 'Regras sem categoria';
const GERAL = 'GERAL';

export async function custosPeriodo(f: FiltroResolvido, base: Record<string, BaseGrupo>): Promise<CustosPeriodo> {
  const de = ymdToUtc(f.de);
  const ate = ymdToUtc(f.ate);

  const [custos, regras, categorias] = await Promise.all([
    prisma.custoOperacional.findMany({
      where: {
        statusPagamento: { not: 'CANCELADO' },
        ...(f.grupo ? { grupo: f.grupo } : {}),
        OR: [{ vencimento: { gte: de, lte: ate } }, { recorrenciaId: { not: null }, vencimento: { lte: ate } }],
      },
      select: {
        id: true, descricao: true, categoriaId: true, grupo: true, valorCentavos: true, vencimento: true, statusPagamento: true,
        categoria: { select: { nome: true } },
        recorrencia: { select: { periodicidade: true, inicio: true, fim: true } },
      },
    }),
    prisma.regraCusto.findMany({
      where: { ativa: true, vigenteDe: { lt: f.ateTsExcl }, OR: [{ vigenteAte: null }, { vigenteAte: { gte: f.deTs } }], ...(f.grupo ? { grupo: f.grupo } : {}) },
    }),
    prisma.categoriaCusto.findMany({ select: { id: true, nome: true } }),
  ]);
  const nomeCategoria = new Map(categorias.map((c) => [c.id, c.nome]));

  const ocorrencias = custos
    .flatMap((c) => ocorrenciasNoPeriodo({ ...c, categoria: c.categoria.nome } as LancamentoBase, de, ate))
    .sort((a, b) => a.data.getTime() - b.data.getTime());

  const regrasInput: RegraCustoInput[] = regras.map((r) => ({
    ...r,
    vigenteDe: ymdToUtc(businessDateString(r.vigenteDe)),
    vigenteAte: r.vigenteAte ? ymdToUtc(businessDateString(r.vigenteAte)) : null,
  }));
  const calculadas = custosDeRegras(regrasInput, de, ate, base);

  const porCategoria = new Map<string, { categoriaId: string | null; categoria: string; totalCentavos: number }>();
  const porGrupo = new Map<string, number>();
  const add = (catId: string | null, cat: string, grupo: string | null, v: number) => {
    const k = catId ?? SEM_CATEGORIA;
    const cur = porCategoria.get(k) ?? { categoriaId: catId, categoria: cat, totalCentavos: 0 };
    cur.totalCentavos += v;
    porCategoria.set(k, cur);
    porGrupo.set(grupo ?? GERAL, (porGrupo.get(grupo ?? GERAL) ?? 0) + v);
  };
  ocorrencias.forEach((o) => add(o.categoriaId, o.categoria, o.grupo, o.valorCentavos));
  calculadas.itens.forEach((r) => add(r.categoriaId, r.categoriaId ? (nomeCategoria.get(r.categoriaId) ?? SEM_CATEGORIA) : SEM_CATEGORIA, r.grupo, r.valorCentavos));

  const lancamentosCentavos = ocorrencias.reduce((s, o) => s + o.valorCentavos, 0);
  const regrasCentavos = calculadas.itens.reduce((s, r) => s + r.valorCentavos, 0);
  return {
    totalCentavos: lancamentosCentavos + regrasCentavos,
    lancamentosCentavos,
    regrasCentavos,
    porCategoria: [...porCategoria.values()].sort((a, b) => b.totalCentavos - a.totalCentavos),
    porGrupo: [...porGrupo.entries()].map(([grupo, totalCentavos]) => ({ grupo, totalCentavos })),
    ocorrencias,
    regras: calculadas,
    metodologia:
      'Custos = lançamentos manuais com vencimento no período (recorrências projetadas inclusas e sinalizadas) + regras de custo vigentes (percentual da receita do critério financeiro escolhido, valor por pedido, valor fixo mensal rateado por dia). Regras por unidade não são calculadas (unidades indisponíveis).',
  };
}

export interface ResultadoFinanceiro {
  receitaBrutaCentavos: number;
  perdasCentavos: number;
  receitaLiquidaCentavos: number;
  comissaoCentavos: number;
  taxaCallCenterCentavos: number;
  custosCentavos: number;
  resultadoOperacionalCentavos: number;
  margemOperacionalPercentual: number | null;
  porGrupo: { grupo: string; receitaCentavos: number; pedidos: number; custosCentavos: number; resultadoCentavos: number; margemPercentual: number | null }[];
  custosNaoAlocadosCentavos: number;
  custos: CustosPeriodo;
  metricas: Metricas;
}

const pct = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 10000) / 100);

export async function resultadoFinanceiro(f: FiltroResolvido): Promise<ResultadoFinanceiro> {
  const grupos = await porDimensao(f, 'grupo');
  const base: Record<string, BaseGrupo> = {};
  grupos.forEach((g) => {
    if (g.chave) base[g.chave] = { receitaCentavos: g.receitaCentavos, pedidos: g.pedidos };
  });
  const metricas = await totais(f);
  const custos = await custosPeriodo(f, base);

  const custoDe = (g: string) => custos.porGrupo.find((c) => c.grupo === g)?.totalCentavos ?? 0;
  const resultado = metricas.receitaCentavos - custos.totalCentavos;
  return {
    receitaBrutaCentavos: metricas.brutoCentavos,
    perdasCentavos: metricas.estornosCentavos + metricas.chargebacksCentavos,
    receitaLiquidaCentavos: metricas.receitaCentavos,
    comissaoCentavos: metricas.comissaoCentavos,
    taxaCallCenterCentavos: metricas.taxaCallCenterCentavos,
    custosCentavos: custos.totalCentavos,
    resultadoOperacionalCentavos: resultado,
    margemOperacionalPercentual: pct(resultado, metricas.receitaCentavos),
    porGrupo: grupos
      .filter((g) => g.chave)
      .map((g) => {
        const c = custoDe(g.chave as string);
        return {
          grupo: g.chave as string,
          receitaCentavos: g.receitaCentavos,
          pedidos: g.pedidos,
          custosCentavos: c,
          resultadoCentavos: g.receitaCentavos - c,
          margemPercentual: pct(g.receitaCentavos - c, g.receitaCentavos),
        };
      }),
    custosNaoAlocadosCentavos: custoDe(GERAL),
    custos,
    metricas,
  };
}

/** Meses civis cobertos por [de, ate], cortados pelas bordas do período. */
export function dividirPorMes(f: FiltroResolvido): FiltroResolvido[] {
  const out: FiltroResolvido[] = [];
  let cursor = `${f.de.slice(0, 7)}-01`;
  while (cursor <= f.ate) {
    const proximoMes = new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const fimMes = addDaysYmd(proximoMes, -1);
    const de = cursor < f.de ? f.de : cursor;
    const ate = fimMes > f.ate ? f.ate : fimMes;
    out.push({ ...f, de, ate, deTs: startOfBusinessDay(de), ateTsExcl: endExclusiveOfBusinessDay(ate) });
    cursor = proximoMes;
  }
  return out;
}

export async function evolucaoFinanceira(f: FiltroResolvido) {
  const meses = dividirPorMes(f);
  const out = [];
  for (const m of meses) {
    const r = await resultadoFinanceiro(m);
    out.push({
      periodo: m.de.slice(0, 7),
      receitaLiquidaCentavos: r.receitaLiquidaCentavos,
      custosCentavos: r.custosCentavos,
      resultadoOperacionalCentavos: r.resultadoOperacionalCentavos,
      margemOperacionalPercentual: r.margemOperacionalPercentual,
    });
  }
  return out;
}

export async function comparativoFinanceiro(f: FiltroResolvido) {
  const ant = filtroAnterior(f);
  const [atual, anterior] = await Promise.all([resultadoFinanceiro(f), resultadoFinanceiro(ant)]);
  const resumo = (r: ResultadoFinanceiro, periodo: { de: string; ate: string }) => ({
    periodo,
    receitaLiquidaCentavos: r.receitaLiquidaCentavos,
    custosCentavos: r.custosCentavos,
    resultadoOperacionalCentavos: r.resultadoOperacionalCentavos,
    margemOperacionalPercentual: r.margemOperacionalPercentual,
  });
  return { atual: resumo(atual, { de: f.de, ate: f.ate }), anterior: resumo(anterior, { de: ant.de, ate: ant.ate }) };
}
