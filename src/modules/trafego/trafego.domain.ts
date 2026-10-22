import { z } from 'zod';

/** Percentuais em pontos-base (10% = 1000; 0,65% = 65) e dinheiro em centavos: nada de ponto flutuante nas contas. */
export const parametrosSchema = z.object({
  taxaCartaoBp: z.number().int().min(0).max(10000),
  pisBp: z.number().int().min(0).max(10000),
  cofinsBp: z.number().int().min(0).max(10000),
  irpjBp: z.number().int().min(0).max(10000),
  csllBp: z.number().int().min(0).max(10000),
  /** custo de UM frete (uma remessa), não de um pedido */
  freteCentavos: z.number().int().min(0).max(10_000_000),
  custoUnitario: z.object({
    padraoCentavos: z.number().int().min(0).max(10_000_000),
    /** primeira regra cujo texto aparece no nome do kit vence (sem acento/caixa) */
    regras: z.array(z.object({ contem: z.string().trim().min(1).max(60), centavos: z.number().int().min(0).max(10_000_000) })).max(30),
  }),
  metaMargemBp: z.number().int().min(0).max(10000),
  /** Deslocamento (min) da janela do dia em relação à meia-noite de São Paulo. Padrão 0: o dia da Pagah (meia-noite a meia-noite de Brasília). */
  janelaDeslocamentoMin: z.number().int().min(-720).max(720),
});
export type Parametros = z.infer<typeof parametrosSchema>;

/** Valores informados pelo time (tela "Para onde vai o faturamento do tráfego"). Editáveis em PUT /trafego/parametros. */
export const PARAMETROS_PADRAO: Parametros = {
  taxaCartaoBp: 1000,
  pisBp: 65,
  cofinsBp: 300,
  irpjBp: 214,
  csllBp: 118,
  freteCentavos: 1790,
  custoUnitario: { padraoCentavos: 610, regras: [{ contem: 'gel', centavos: 990 }] },
  metaMargemBp: 2000,
  janelaDeslocamentoMin: 0,
};

const semAcento = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Unidades (frascos) de um kit a partir do nome: "6 Nervepure", "NeuroSilence Gotas - 5 Frascos", "10 NeuroSilence". */
export function unidadesDoKit(nome: string | null): { unidades: number; detectado: boolean } {
  // remove marcações iniciais como "(upsell)", "(Upsell) -" ou "[CALLCENTER]"
  const s = (nome ?? '').replace(/^\s*checkout\s*\|\s*/i, '').replace(/^\s*([([][^)\]]*[)\]]\s*-?\s*)+/, '');
  const frascos = /(\d{1,3})\s*(?:frascos?|potes?|caixas?|unidades?|un(?![a-z]))/i.exec(s);
  if (frascos) return { unidades: Number(frascos[1]), detectado: true };
  const inicio = /^\s*(\d{1,3})\s+\S/.exec(s);
  if (inicio) return { unidades: Number(inicio[1]), detectado: true };
  return { unidades: 1, detectado: false };
}

export function custoUnitarioDoKit(nome: string | null, p: Parametros): number {
  const n = semAcento(nome ?? '');
  const regra = p.custoUnitario.regras.find((r) => n.includes(semAcento(r.contem)));
  return regra ? regra.centavos : p.custoUnitario.padraoCentavos;
}

export interface KitAgregado {
  kit: string | null;
  pedidos: number;
}

export function custoDeProduto(kits: KitAgregado[], p: Parametros): { custoCentavos: number; unidades: number; itens: number; kitsSemQuantidade: number } {
  let custo = 0;
  let unidades = 0;
  let itens = 0;
  let sem = 0;
  for (const k of kits) {
    const u = unidadesDoKit(k.kit);
    if (!u.detectado) sem += k.pedidos;
    unidades += u.unidades * k.pedidos;
    itens += k.pedidos;
    custo += u.unidades * k.pedidos * custoUnitarioDoKit(k.kit, p);
  }
  return { custoCentavos: custo, unidades, itens, kitsSemQuantidade: sem };
}

export const aplicarBp = (baseCentavos: number, bp: number): number => Math.round((baseCentavos * bp) / 10000);
const razao = (parte: number, todo: number): number | null => (todo === 0 ? null : Math.round((parte * 10000) / todo));
const porPedido = (valor: number, pedidos: number): number | null => (pedidos === 0 ? null : Math.round(valor / pedidos));

export interface EntradaResumo {
  faturamentoCentavos: number;
  pedidos: number;
  fretes: number;
  kits: KitAgregado[];
  investimentoCentavos: number | null;
}

export interface LinhaCusto {
  codigo: string;
  nome: string;
  /** subtítulo curto (ex.: "10%" ou "504 × R$ 17,90") */
  rotulo: string;
  comoCalculado: string;
  valorCentavos: number | null;
  percentualFaturamentoBp: number | null;
  porPedidoCentavos: number | null;
}

const brl = (c: number): string => `R$ ${Math.trunc(c / 100).toLocaleString('pt-BR')},${String(c % 100).padStart(2, '0')}`;
const pct = (bp: number): string => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

export function montarResumo(e: EntradaResumo, p: Parametros) {
  const fat = e.faturamentoCentavos;
  const mk = (codigo: string, nome: string, rotulo: string, como: string, valor: number | null): LinhaCusto => ({
    codigo, nome, rotulo, comoCalculado: como, valorCentavos: valor,
    percentualFaturamentoBp: valor === null ? null : razao(valor, fat),
    porPedidoCentavos: valor === null ? null : porPedido(valor, e.pedidos),
  });
  const imposto = (cod: string, nome: string, bp: number) => mk(cod, nome, pct(bp), `${pct(bp)} sobre o faturamento de ${brl(fat)}`, aplicarBp(fat, bp));
  const prod = custoDeProduto(e.kits, p);
  const freteTotal = e.fretes * p.freteCentavos;
  const regras = p.custoUnitario.regras.map((r) => `${r.contem} ${brl(r.centavos)}`);

  const linhas: LinhaCusto[] = [
    mk('investimento', 'Investimento em anúncios', '', 'Gasto em anúncios no período, todas as fontes (campanhas do RedTrack)', e.investimentoCentavos),
    imposto('taxa-cartao', 'Taxa de cartão', p.taxaCartaoBp),
    imposto('pis', 'PIS', p.pisBp),
    imposto('cofins', 'Cofins', p.cofinsBp),
    imposto('irpj', 'Provisão básica de IRPJ', p.irpjBp),
    imposto('csll', 'Provisão básica de CSLL', p.csllBp),
    mk('frete', 'Frete', `${e.fretes} × ${brl(p.freteCentavos)}`, `${brl(p.freteCentavos)} por remessa × ${e.fretes} remessas (pedidos do mesmo cliente enviados juntos contam um frete só)`, freteTotal),
    mk(
      'custo-produto',
      'Custo de produto',
      `${prod.unidades.toLocaleString('pt-BR')} un. em ${prod.itens.toLocaleString('pt-BR')} itens vendidos`,
      `${prod.unidades.toLocaleString('pt-BR')} unidades vendidas × custo unitário (${[...regras, `demais ${brl(p.custoUnitario.padraoCentavos)}`].join('; ')})`,
      prod.custoCentavos,
    ),
  ];

  const semInvestimento = e.investimentoCentavos === null;
  const totalCustos = linhas.reduce((s, l) => s + (l.valorCentavos ?? 0), 0);
  const sobra = semInvestimento ? null : fat - totalCustos;
  return {
    faturamentoCentavos: fat,
    pedidos: e.pedidos,
    ticketMedioCentavos: porPedido(fat, e.pedidos),
    investimentoCentavos: e.investimentoCentavos,
    /** ROAS × 100 (185 = 1,85); null sem investimento */
    roasCentesimos: e.investimentoCentavos ? Math.round((fat * 100) / e.investimentoCentavos) : null,
    cpaCentavos: e.investimentoCentavos === null ? null : porPedido(e.investimentoCentavos, e.pedidos),
    linhas,
    totalCustosCentavos: semInvestimento ? null : totalCustos,
    totalCustosSemInvestimentoCentavos: totalCustos,
    totalCustosPorPedidoCentavos: semInvestimento ? null : porPedido(totalCustos, e.pedidos),
    totalCustosPercentualBp: semInvestimento ? null : razao(totalCustos, fat),
    sobraCentavos: sobra,
    margemBp: sobra === null ? null : razao(sobra, fat),
    metaMargemBp: p.metaMargemBp,
    remessas: e.fretes,
    unidades: prod.unidades,
    itens: prod.itens,
    kitsSemQuantidade: prod.kitsSemQuantidade,
  };
}

export interface EntradaCallCenter {
  /** faturamento = valor sem juros dos pagamentos do período (bruto, sem descontar estornos): mesma base do Front */
  faturamentoCentavos: number;
  /** receita líquida do critério ativo (informativa) */
  receitaLiquidaCentavos: number;
  pedidos: number;
  remessas: number;
  kits: KitAgregado[];
  /** custos da operação (lançamentos + regras do grupo); null = sem permissão para ver custos */
  custosOperacaoCentavos: number | null;
}

/** "Para onde vai a receita do Call Center": mesmas taxas do Front sobre o faturamento (bruto) do grupo, frete por remessa e custo de produto. */
export function montarResumoCallCenter(e: EntradaCallCenter, p: Parametros) {
  const rec = e.faturamentoCentavos;
  const mk = (codigo: string, nome: string, rotulo: string, como: string, valor: number): LinhaCusto => ({
    codigo, nome, rotulo, comoCalculado: como, valorCentavos: valor,
    percentualFaturamentoBp: razao(valor, rec),
    porPedidoCentavos: porPedido(valor, e.pedidos),
  });
  const imposto = (cod: string, nome: string, bp: number) => mk(cod, `${nome} (call center)`, pct(bp), `${pct(bp)} sobre o faturamento de ${brl(rec)}`, aplicarBp(rec, bp));
  const prod = custoDeProduto(e.kits, p);
  const regras = p.custoUnitario.regras.map((r) => `${r.contem} ${brl(r.centavos)}`);
  const linhas: LinhaCusto[] = [
    imposto('taxa-cartao', 'Taxa de cartão', p.taxaCartaoBp),
    mk('frete', 'Frete (call center)', `${e.remessas} × ${brl(p.freteCentavos)}`, `${brl(p.freteCentavos)} por remessa × ${e.remessas} remessas (pedidos do mesmo cliente enviados juntos contam um frete só)`, e.remessas * p.freteCentavos),
    imposto('pis', 'PIS', p.pisBp),
    imposto('cofins', 'Cofins', p.cofinsBp),
    imposto('irpj', 'Provisão básica de IRPJ', p.irpjBp),
    imposto('csll', 'Provisão básica de CSLL', p.csllBp),
    mk(
      'custo-produto',
      'Custo de produto (call center)',
      `${prod.unidades.toLocaleString('pt-BR')} un.`,
      `${prod.unidades.toLocaleString('pt-BR')} unidades dos kits do call center × custo unitário (${[...regras, `demais ${brl(p.custoUnitario.padraoCentavos)}`].join('; ')})`,
      prod.custoCentavos,
    ),
  ];
  const total = linhas.reduce((s, l) => s + (l.valorCentavos ?? 0), 0);
  const operacao = e.custosOperacaoCentavos;
  const sobra = operacao === null ? null : rec - total - operacao;
  return {
    faturamentoCentavos: rec,
    receitaLiquidaCentavos: e.receitaLiquidaCentavos,
    pedidos: e.pedidos,
    ticketMedioCentavos: porPedido(rec, e.pedidos),
    unidades: prod.unidades,
    remessas: e.remessas,
    linhas,
    totalCustosCentavos: total,
    totalCustosPorPedidoCentavos: porPedido(total, e.pedidos),
    totalCustosPercentualBp: razao(total, rec),
    custosOperacaoCentavos: operacao,
    /** sobra = receita − custos da tabela − custos da operação; null sem permissão para ver custos */
    sobraCentavos: sobra,
    margemBp: sobra === null ? null : razao(sobra, rec),
    kitsSemQuantidade: prod.kitsSemQuantidade,
  };
}
