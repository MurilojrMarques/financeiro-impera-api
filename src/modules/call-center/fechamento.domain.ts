import { origemEhCallCenter } from '../classificacoes/classificacao.service';
import { searchKey } from '../../shared/utils/text';

/**
 * O fechamento do Call Center do dono, na fórmula da planilha dele ("Fechamento <empresa>", aba Fechamento), sem desvio.
 * É o número que ele fecha na mão com o Pagah, e o sistema passa a reproduzi-lo para conferir:
 *
 *   VENDAS = pedido com `origem` "Call" ou "Whats" (a `QUERY` dele), PAGO NO MÊS e ainda pago NO FIM DELE: quem foi
 *            estornado ou virou chargeback dentro do mês some, sem entrar como venda nem como chargeback. Quem só foi
 *            revertido depois do fim do mês conta como venda do mês e a reversão pesa no mês seguinte, como num fechamento
 *            tirado logo depois da virada (o arquivo dele reflete a posição do dia em que foi exportado, e o nosso banco
 *            reflete a de hoje, então a data da reversão é que manda). Valor: cartão = `valor_sem_juros`; boleto e pix =
 *            `total_pedido` (colunas J e I).
 *   CHARGEBACKS = pedido de origem Call/Whats pago ANTES do mês, estornado ou com chargeback DENTRO do mês. Valor:
 *            `valor_sem_juros`.
 *   COMISSÃO = 20% das vendas, e o desconto de 20% dos chargebacks.
 *
 * A origem manda: não depende do grupo da classificação. Pedido sem origem do Pagah não tem como entrar e é contado à parte
 * (avisos), nunca somado por adivinhação.
 */

export const COMISSAO_CALL_CENTER = 0.2;

export type MetodoFechamento = 'CARTAO' | 'BOLETO' | 'PIX';

export interface VendaDoFechamento {
  pedido: string;
  origem: string | null;
  status: 'PAGO' | 'ESTORNADO' | 'CHARGEBACK' | 'PENDENTE_CONCILIACAO';
  metodoPagamento: string | null;
  parcelas: number | null;
  pagoEm: Date | null;
  /** quando o estorno ou o chargeback aconteceu */
  perdaEm: Date | null;
  valorVendaCentavos: number; // valor_sem_juros
  valorTotalCentavos: number | null; // total_pedido
  jurosCentavos: number | null;
}

export interface LinhaPorMetodo {
  metodo: MetodoFechamento;
  pedidos: number;
  totalCentavos: number;
  comissaoCentavos: number;
}

export interface FechamentoCallCenter {
  /** AAAA-MM quando o pedido foi de um mês; nulo quando foi um período livre */
  mes: string | null;
  periodo: { de: string; ate: string };
  vendas: { pedidos: number; totalCentavos: number; porMetodo: LinhaPorMetodo[] };
  chargebacks: { pedidos: number; totalCentavos: number };
  comissao: {
    percentual: number;
    vendasCentavos: number;
    descontoChargebackCentavos: number;
    liquidaCentavos: number;
  };
  avisos: {
    /** vendas pagas no mês, ainda pagas, sem `origem` do Pagah: não entram e não dá para saber se são Call/Whats */
    semOrigem: { pedidos: number; totalCentavos: number };
    /** estornos e chargebacks do mês de pedidos pagos antes dele e sem `origem`: idem, ficam fora do desconto */
    chargebacksSemOrigem: { pedidos: number; totalCentavos: number };
    /** vendas do período, de origem Call/Whats, estornadas ou com chargeback DENTRO dele: fora das duas pontas, como na planilha */
    revertidasNoMes: { pedidos: number; totalCentavos: number };
    /** vendas do período revertidas só DEPOIS do fim dele: contam como venda agora e a reversão pesa no período seguinte */
    revertidasDepois: { pedidos: number; totalCentavos: number };
    /** chargeback/estorno de cartão parcelado com o valor sem juros igual ao total: provável juros dentro do número */
    possivelJurosNosChargebacks: { pedidos: number; totalCentavos: number };
  };
}

function metodoDe(m: string | null): MetodoFechamento | null {
  switch (searchKey(m)) {
    case 'cartao':
      return 'CARTAO';
    case 'boleto':
      return 'BOLETO';
    case 'pix':
      return 'PIX';
    default:
      return null;
  }
}

/** O valor que a planilha soma: cartão no `valor_sem_juros`, boleto e pix no `total_pedido`. */
export function valorDaPlanilha(v: Pick<VendaDoFechamento, 'metodoPagamento' | 'valorVendaCentavos' | 'valorTotalCentavos'>): number {
  return metodoDe(v.metodoPagamento) === 'CARTAO' ? v.valorVendaCentavos : (v.valorTotalCentavos ?? v.valorVendaCentavos);
}

/** `mes` = AAAA-MM. Início e fim do mês em Brasília (a planilha do dono fecha por dia de calendário). */
export function limitesDoMes(mes: string): { inicio: Date; fim: Date; de: string; ate: string } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(mes);
  if (!m) throw new Error(`mês inválido: ${mes} (esperado AAAA-MM)`);
  const ano = Number(m[1]);
  const mm = Number(m[2]);
  const proximo = mm === 12 ? `${ano + 1}-01` : `${ano}-${String(mm + 1).padStart(2, '0')}`;
  const ultimo = new Date(Date.UTC(ano, mm, 0)).getUTCDate();
  return {
    inicio: new Date(`${mes}-01T00:00:00-03:00`),
    fim: new Date(`${proximo}-01T00:00:00-03:00`),
    de: `${mes}-01`,
    ate: `${mes}-${String(ultimo).padStart(2, '0')}`,
  };
}

/** Um período livre (AAAA-MM-DD a AAAA-MM-DD, ambos os dias inclusos), em Brasília. */
export function limitesDoPeriodo(de: string, ate: string): { inicio: Date; fim: Date; de: string; ate: string } {
  const ok = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00-03:00`));
  if (!ok(de) || !ok(ate) || de > ate) throw new Error(`período inválido: ${de} a ${ate}`);
  const depois = new Date(Date.UTC(Number(ate.slice(0, 4)), Number(ate.slice(5, 7)) - 1, Number(ate.slice(8, 10)) + 1));
  const prox = `${depois.getUTCFullYear()}-${String(depois.getUTCMonth() + 1).padStart(2, '0')}-${String(depois.getUTCDate()).padStart(2, '0')}`;
  return { inicio: new Date(`${de}T00:00:00-03:00`), fim: new Date(`${prox}T00:00:00-03:00`), de, ate };
}

const dentro = (d: Date | null, a: Date, b: Date) => d !== null && d >= a && d < b;
const soma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export interface ConjuntosDoFechamento {
  vendidas: VendaDoFechamento[];
  chargebacks: VendaDoFechamento[];
  semOrigem: VendaDoFechamento[];
  chargebacksSemOrigem: VendaDoFechamento[];
  revertidasNoMes: VendaDoFechamento[];
  revertidasDepois: VendaDoFechamento[];
}

/**
 * Separa os pedidos nas pontas do fechamento. `posicaoEm` é "como estava" nesse instante: quem foi revertido antes dele já
 * saiu das vendas. Por padrão é o FIM do período (um fechamento correto não sabe do que acontece depois). Para reproduzir um
 * arquivo exportado em outro dia, passe o instante da exportação: o dono exportou em 03/11 e o arquivo traz como pago quem só
 * foi revertido nesse dia.
 */
export function separarFechamento(
  alvo: string | { de: string; ate: string },
  vendas: ReadonlyArray<VendaDoFechamento>,
  posicaoEm?: Date,
): ConjuntosDoFechamento & { inicio: Date; fim: Date; de: string; ate: string; mes: string | null } {
  const mes = typeof alvo === 'string' ? alvo : null;
  const { inicio, fim, de, ate } = typeof alvo === 'string' ? limitesDoMes(alvo) : limitesDoPeriodo(alvo.de, alvo.ate);
  const posicao = posicaoEm ?? fim;
  const foiRevertida = (v: VendaDoFechamento) => v.status === 'ESTORNADO' || v.status === 'CHARGEBACK';

  // Reverteu até a posição (ou sem data de reversão) some; reverteu depois dela, ainda é venda deste período.
  const revertidaAteAPosicao = (v: VendaDoFechamento) => foiRevertida(v) && (v.perdaEm === null || v.perdaEm < posicao);
  const noMes = vendas.filter((v) => dentro(v.pagoEm, inicio, fim));
  const callNoMes = noMes.filter((v) => origemEhCallCenter(v.origem));
  const chargebackDoPeriodo = (v: VendaDoFechamento) =>
    foiRevertida(v) && v.pagoEm !== null && v.pagoEm < inicio && dentro(v.perdaEm, inicio, fim);

  return {
    inicio, fim, de, ate, mes,
    vendidas: callNoMes.filter((v) => !revertidaAteAPosicao(v)),
    revertidasNoMes: callNoMes.filter(revertidaAteAPosicao),
    revertidasDepois: callNoMes.filter((v) => foiRevertida(v) && v.perdaEm !== null && v.perdaEm >= posicao),
    semOrigem: noMes.filter((v) => !revertidaAteAPosicao(v) && !v.origem?.trim()),
    chargebacks: vendas.filter((v) => origemEhCallCenter(v.origem) && chargebackDoPeriodo(v)),
    chargebacksSemOrigem: vendas.filter((v) => !v.origem?.trim() && chargebackDoPeriodo(v)),
  };
}

/** `alvo` = AAAA-MM (o mês inteiro) ou um período livre. Quem foi pago ANTES do início é de período anterior. */
export function calcularFechamento(
  alvo: string | { de: string; ate: string },
  vendas: ReadonlyArray<VendaDoFechamento>,
  posicaoEm?: Date,
): FechamentoCallCenter {
  const { mes, de, ate, vendidas, chargebacks, semOrigem, chargebacksSemOrigem: cbSemOrigem, revertidasNoMes, revertidasDepois } = separarFechamento(alvo, vendas, posicaoEm);

  const porMetodo: LinhaPorMetodo[] = (['CARTAO', 'BOLETO', 'PIX'] as const).map((metodo) => {
    const linhas = vendidas.filter((v) => metodoDe(v.metodoPagamento) === metodo);
    const total = soma(linhas.map(valorDaPlanilha));
    return { metodo, pedidos: linhas.length, totalCentavos: total, comissaoCentavos: Math.round(total * COMISSAO_CALL_CENTER) };
  });
  const totalVendas = soma(porMetodo.map((l) => l.totalCentavos));
  const totalCb = soma(chargebacks.map((v) => v.valorVendaCentavos));
  const comissaoVendas = soma(porMetodo.map((l) => l.comissaoCentavos));
  const descontoCb = Math.round(totalCb * COMISSAO_CALL_CENTER);

  const jurosPossiveis = chargebacks.filter(
    (v) => metodoDe(v.metodoPagamento) === 'CARTAO' && (v.parcelas ?? 1) > 1 && v.valorTotalCentavos === v.valorVendaCentavos && v.jurosCentavos === null,
  );
  const resumo = (xs: VendaDoFechamento[]) => ({ pedidos: xs.length, totalCentavos: soma(xs.map(valorDaPlanilha)) });

  return {
    mes,
    periodo: { de, ate },
    vendas: { pedidos: vendidas.length, totalCentavos: totalVendas, porMetodo },
    chargebacks: { pedidos: chargebacks.length, totalCentavos: totalCb },
    comissao: {
      percentual: COMISSAO_CALL_CENTER,
      vendasCentavos: comissaoVendas,
      descontoChargebackCentavos: descontoCb,
      liquidaCentavos: comissaoVendas - descontoCb,
    },
    avisos: {
      semOrigem: resumo(semOrigem),
      chargebacksSemOrigem: { pedidos: cbSemOrigem.length, totalCentavos: soma(cbSemOrigem.map((v) => v.valorVendaCentavos)) },
      revertidasNoMes: resumo(revertidasNoMes),
      revertidasDepois: resumo(revertidasDepois),
      possivelJurosNosChargebacks: { pedidos: jurosPossiveis.length, totalCentavos: soma(jurosPossiveis.map((v) => v.valorVendaCentavos)) },
    },
  };
}
