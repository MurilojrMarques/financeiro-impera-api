import { applyBps } from '../../shared/utils/money';

export interface LancamentoBase {
  id: string;
  descricao: string;
  categoriaId: string;
  categoria: string;
  grupo: string | null;
  valorCentavos: number;
  vencimento: Date; // @db.Date (UTC meia-noite)
  statusPagamento: 'PENDENTE' | 'PAGO' | 'CANCELADO';
  recorrencia: { periodicidade: 'SEMANAL' | 'MENSAL' | 'TRIMESTRAL' | 'ANUAL'; inicio: Date; fim: Date | null } | null;
}

export interface OcorrenciaCusto {
  custoId: string;
  descricao: string;
  categoriaId: string;
  categoria: string;
  grupo: string | null;
  valorCentavos: number;
  data: Date;
  statusPagamento: string;
  projetada: boolean;
}

const addMonths = (d: Date, n: number): Date => {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay)));
};

function proxima(p: NonNullable<LancamentoBase['recorrencia']>['periodicidade'], i: number, base: Date): Date {
  switch (p) {
    case 'SEMANAL':
      return new Date(base.getTime() + i * 7 * 86_400_000);
    case 'MENSAL':
      return addMonths(base, i);
    case 'TRIMESTRAL':
      return addMonths(base, 3 * i);
    case 'ANUAL':
      return addMonths(base, 12 * i);
  }
}

/** Ocorrências de um lançamento (incluindo projeções de recorrência) dentro de [de, ate] (datas UTC-meia-noite). */
export function ocorrenciasNoPeriodo(c: LancamentoBase, de: Date, ate: Date): OcorrenciaCusto[] {
  if (c.statusPagamento === 'CANCELADO') return [];
  const out: OcorrenciaCusto[] = [];
  const mk = (data: Date, projetada: boolean): OcorrenciaCusto => ({
    custoId: c.id,
    descricao: c.descricao,
    categoriaId: c.categoriaId,
    categoria: c.categoria,
    grupo: c.grupo,
    valorCentavos: c.valorCentavos,
    data,
    statusPagamento: projetada ? 'PENDENTE' : c.statusPagamento,
    projetada,
  });
  if (!c.recorrencia) {
    if (c.vencimento >= de && c.vencimento <= ate) out.push(mk(c.vencimento, false));
    return out;
  }
  const limite = c.recorrencia.fim && c.recorrencia.fim < ate ? c.recorrencia.fim : ate;
  for (let i = 0; i < 1000; i++) {
    const data = proxima(c.recorrencia.periodicidade, i, c.vencimento);
    if (data > limite) break;
    if (data >= de && data >= c.recorrencia.inicio) out.push(mk(data, i > 0));
  }
  return out;
}

export interface RegraCustoInput {
  id: string;
  nome: string;
  tipo: 'PERCENTUAL_RECEITA' | 'VALOR_POR_PEDIDO' | 'VALOR_POR_UNIDADE' | 'VALOR_FIXO_PERIODO';
  grupo: string | null;
  categoriaId: string | null;
  valorCentavos: number | null;
  percentualBps: number | null;
  vigenteDe: Date;
  vigenteAte: Date | null;
  metodologia: string;
}

export interface BaseGrupo {
  receitaCentavos: number;
  pedidos: number;
}

export interface CustoDeRegra {
  regraId: string;
  nome: string;
  tipo: RegraCustoInput['tipo'];
  grupo: string | null;
  categoriaId: string | null;
  valorCentavos: number;
  metodologia: string;
}

export interface RegraIndisponivel {
  regraId: string;
  nome: string;
  motivo: string;
}

const DIA = 86_400_000;

const MAX_DATE = 8.64e15;

/** Valor fixo MENSAL rateado por dia: para cada mês civil, valor × (dias do mês em período ∩ vigência) / dias do mês. */
function fixoRateado(valor: number, de: Date, ate: Date, vigDe: Date, vigAte: Date | null): number {
  const fimVig = vigAte ?? new Date(MAX_DATE);
  let total = 0;
  let cursor = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1));
  while (cursor <= ate) {
    const diasNoMes = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    const fimMes = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), diasNoMes);
    const ini = Math.max(cursor.getTime(), de.getTime(), vigDe.getTime());
    const fim = Math.min(fimMes, ate.getTime(), fimVig.getTime());
    const dias = fim < ini ? 0 : Math.round((fim - ini) / DIA) + 1;
    total += Math.round((valor * dias) / diasNoMes);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return total;
}

export function custosDeRegras(
  regras: RegraCustoInput[],
  de: Date,
  ate: Date,
  porGrupo: Record<string, BaseGrupo>,
): { itens: CustoDeRegra[]; indisponiveis: RegraIndisponivel[] } {
  const itens: CustoDeRegra[] = [];
  const indisponiveis: RegraIndisponivel[] = [];
  const total: BaseGrupo = Object.values(porGrupo).reduce(
    (acc, g) => ({ receitaCentavos: acc.receitaCentavos + g.receitaCentavos, pedidos: acc.pedidos + g.pedidos }),
    { receitaCentavos: 0, pedidos: 0 },
  );

  for (const r of regras) {
    const base = r.grupo ? (porGrupo[r.grupo] ?? { receitaCentavos: 0, pedidos: 0 }) : total;
    let valor: number | null = null;
    if (r.tipo === 'PERCENTUAL_RECEITA' && r.percentualBps !== null) valor = applyBps(base.receitaCentavos, r.percentualBps);
    else if (r.tipo === 'VALOR_POR_PEDIDO' && r.valorCentavos !== null) valor = base.pedidos * r.valorCentavos;
    else if (r.tipo === 'VALOR_FIXO_PERIODO' && r.valorCentavos !== null) valor = fixoRateado(r.valorCentavos, de, ate, r.vigenteDe, r.vigenteAte);
    else if (r.tipo === 'VALOR_POR_UNIDADE') {
      indisponiveis.push({ regraId: r.id, nome: r.nome, motivo: 'unidades vendidas não existem na planilha; regra não calculada' });
      continue;
    }
    if (valor === null) {
      indisponiveis.push({ regraId: r.id, nome: r.nome, motivo: 'parâmetros da regra incompletos para o tipo' });
      continue;
    }
    itens.push({ regraId: r.id, nome: r.nome, tipo: r.tipo, grupo: r.grupo, categoriaId: r.categoriaId, valorCentavos: valor, metodologia: r.metodologia });
  }
  return { itens, indisponiveis };
}
