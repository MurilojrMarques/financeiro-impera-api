import type { Request } from 'express';
import { porDimensao, totais, type LinhaDimensao, type Metricas } from '../../shared/repositories/ledger.repository';
import { formatar } from '../../shared/services/relatorio.service';
import type { FiltroResolvido } from '../../shared/validators/filtros';
import { resultadoFinanceiro } from '../financeiro/financeiro.service';

const GRUPOS_EXCLUSIVOS = ['FRONT', 'BACKEND_OUTROS', 'CALL_CENTER', 'RECUPERACAO', 'AFILIADO', 'NAO_CLASSIFICADA'] as const;

export const podeVerCustos = (req: Request): boolean => req.user?.perfil === 'ADMIN' || req.user?.perfil === 'FINANCEIRO';

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10000) / 100);

const zero = (): Metricas => ({
  pedidos: 0, brutoCentavos: 0, receitaCentavos: 0, comissaoCentavos: 0, comissaoAfiliadoCentavos: 0, comissaoAfiliadoEstimadaCentavos: 0, comissaoEstimadaCentavos: 0,
  x1ComissaoRealCentavos: 0, pedidosSemComissao: 0, taxaCallCenterCentavos: 0, estornosCentavos: 0,
  estornosQtd: 0, chargebacksCentavos: 0, chargebacksQtd: 0,
});

function metricasDe(linhas: LinhaDimensao[], grupo: string): Metricas {
  const l = linhas.find((x) => x.chave === grupo);
  if (!l) return zero();
  const { chave: _c, id: _i, ...m } = l;
  return m;
}

const somar = (a: Metricas, b: Metricas): Metricas => {
  const r = zero();
  (Object.keys(r) as (keyof Metricas)[]).forEach((k) => (r[k] = a[k] + b[k]));
  return r;
};

/** Receitas por grupos MUTUAMENTE EXCLUSIVOS + visões derivadas (backendTotal não entra na soma geral). */
export async function receitasPorGrupo(f: FiltroResolvido) {
  const linhas = await porDimensao(f, 'grupo');
  const g = Object.fromEntries(GRUPOS_EXCLUSIVOS.map((k) => [k, metricasDe(linhas, k)])) as Record<(typeof GRUPOS_EXCLUSIVOS)[number], Metricas>;
  const geral = GRUPOS_EXCLUSIVOS.reduce((acc, k) => somar(acc, g[k]), zero());
  // Back-end consolidado = tudo que o time fecha depois do front: back-end (SMS/e-mail/disparo) + call center + recuperação de vendas
  const backendTotal = somar(somar(g.BACKEND_OUTROS, g.CALL_CENTER), g.RECUPERACAO);
  return {
    grupos: {
      front: formatar(g.FRONT, f.modo),
      backendOutros: formatar(g.BACKEND_OUTROS, f.modo),
      callCenter: formatar(g.CALL_CENTER, f.modo),
      recuperacao: formatar(g.RECUPERACAO, f.modo),
      afiliados: formatar(g.AFILIADO, f.modo),
      naoClassificadas: formatar(g.NAO_CLASSIFICADA, f.modo),
    },
    backendTotal: formatar(backendTotal, f.modo),
    geral: formatar(geral, f.modo),
    composicao: {
      receitaGeral: 'front + backendOutros + callCenter + recuperacao + afiliados + naoClassificadas',
      backendTotal: 'backendOutros + callCenter + recuperacao (indicador agregado; NÃO entra na receita geral)',
    },
  };
}

export async function kpis(f: FiltroResolvido, req: Request) {
  const [m, g] = await Promise.all([totais(f), receitasPorGrupo(f)]);
  const base = {
    ...formatar(m, f.modo),
    receitaFrontCentavos: g.grupos.front.receitaCentavos,
    receitaBackendOutrosCentavos: g.grupos.backendOutros.receitaCentavos,
    receitaCallCenterCentavos: g.grupos.callCenter.receitaCentavos,
    receitaRecuperacaoCentavos: g.grupos.recuperacao.receitaCentavos,
    receitaAfiliadosCentavos: g.grupos.afiliados.receitaCentavos,
    receitaNaoClassificadaCentavos: g.grupos.naoClassificadas.receitaCentavos,
    receitaBackendTotalCentavos: g.backendTotal.receitaCentavos,
  };
  if (!podeVerCustos(req)) {
    return { ...base, custos: { disponivel: false, motivo: 'custos e resultado exigem perfil FINANCEIRO ou ADMIN' } };
  }
  const r = await resultadoFinanceiro(f);
  return {
    ...base,
    custos: {
      disponivel: true,
      custosCentavos: r.custosCentavos,
      resultadoOperacionalCentavos: r.resultadoOperacionalCentavos,
      margemOperacionalPercentual: r.margemOperacionalPercentual,
    },
  };
}

export async function distribuicaoReceitas(f: FiltroResolvido) {
  const r = await receitasPorGrupo(f);
  const total = r.geral.receitaCentavos;
  const itens = [
    ['FRONT', r.grupos.front], ['BACKEND_OUTROS', r.grupos.backendOutros], ['CALL_CENTER', r.grupos.callCenter], ['RECUPERACAO', r.grupos.recuperacao],
    ['AFILIADO', r.grupos.afiliados], ['NAO_CLASSIFICADA', r.grupos.naoClassificadas],
  ] as const;
  return {
    totalCentavos: total,
    // participações sobre a receita geral; somam 100% porque os grupos são mutuamente exclusivos
    distribuicao: itens.map(([grupo, m]) => ({ grupo, receitaCentavos: m.receitaCentavos, participacaoPercentual: pct(m.receitaCentavos, total) })),
    backendTotal: { receitaCentavos: r.backendTotal.receitaCentavos, participacaoPercentual: pct(r.backendTotal.receitaCentavos, total), nota: 'agregado de BACKEND_OUTROS + CALL_CENTER + RECUPERACAO' },
  };
}

export async function indicadores(f: FiltroResolvido, req: Request) {
  const [mov, aprov, atual, g] = await Promise.all([
    totais({ ...f, modo: 'MOVIMENTACAO' }),
    totais({ ...f, modo: 'APROVADAS' }),
    totais(f),
    receitasPorGrupo(f),
  ]);
  const ind = (codigo: string, valor: number | null, unidade: 'centavos' | 'quantidade' | 'percentual', metodologia: string) => ({
    codigo, valor, unidade, disponivel: valor !== null, metodologia,
  });
  const lista = [
    ind('faturamentoBrutoPago', mov.brutoCentavos, 'centavos', 'Soma de valor_sem_juros dos pedidos pagos no período.'),
    ind('faturamentoLiquidoAjustado', mov.receitaCentavos, 'centavos', 'MOVIMENTACAO: pagamentos do período − perdas reconhecidas na data do evento.'),
    ind('receitaAprovadaPainel', aprov.receitaCentavos, 'centavos', 'APROVADAS: pedidos pagos no período pelo status atual (aproxima o painel Pagah).'),
    ind('quantidadePedidos', atual.pedidos, 'quantidade', `Pedidos pagos no período (critério ${f.modo}).`),
    ind('ticketMedio', formatar(atual, f.modo).ticketMedioCentavos, 'centavos', 'APROVADAS: receita/pedidos. MOVIMENTACAO: faturamento bruto/pedidos.'),
    ind('comissao', atual.comissaoCentavos, 'centavos', 'Soma de comissões; X1 = 0 por padrão; estimadas incluídas e sinalizadas em alertas.'),
    ind('estornos', atual.estornosCentavos, 'centavos', 'Perdas atribuídas a estorno (contadas uma única vez por pedido).'),
    ind('chargebacks', atual.chargebacksCentavos, 'centavos', 'Perdas atribuídas a chargeback (contadas uma única vez por pedido).'),
    ind('receitaFront', g.grupos.front.receitaCentavos, 'centavos', 'Grupo FRONT.'),
    ind('receitaBackendOutros', g.grupos.backendOutros.receitaCentavos, 'centavos', 'Grupo BACKEND_OUTROS (não inclui Call Center).'),
    ind('receitaCallCenter', g.grupos.callCenter.receitaCentavos, 'centavos', 'Grupo CALL_CENTER.'),
    ind('receitaRecuperacao', g.grupos.recuperacao.receitaCentavos, 'centavos', 'Grupo RECUPERACAO (time interno, sem a taxa de 20% do call center).'),
    ind('receitaAfiliados', g.grupos.afiliados.receitaCentavos, 'centavos', 'Grupo AFILIADO.'),
    ind('receitaBackendTotal', g.backendTotal.receitaCentavos, 'centavos', 'BACKEND_OUTROS + CALL_CENTER + RECUPERACAO (agregado; não somar de novo).'),
    ind('unidadesVendidas', null, 'quantidade', 'Indisponível: a planilha não traz unidades.'),
  ];
  if (podeVerCustos(req)) {
    const r = await resultadoFinanceiro(f);
    lista.push(
      ind('custos', r.custosCentavos, 'centavos', r.custos.metodologia),
      ind('resultadoOperacional', r.resultadoOperacionalCentavos, 'centavos', 'Receita líquida − custos (lançamentos + regras).'),
      ind('margemOperacional', r.margemOperacionalPercentual, 'percentual', 'Resultado operacional / receita líquida.'),
    );
  } else {
    lista.push(
      ind('custos', null, 'centavos', 'Restrito a FINANCEIRO/ADMIN.'),
      ind('resultadoOperacional', null, 'centavos', 'Restrito a FINANCEIRO/ADMIN.'),
      ind('margemOperacional', null, 'percentual', 'Restrito a FINANCEIRO/ADMIN.'),
    );
  }
  return lista;
}
