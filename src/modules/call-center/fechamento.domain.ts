import { origemEhCallCenter } from '../classificacoes/classificacao.service';
import { searchKey } from '../../shared/utils/text';

/**
 * O fechamento do Call Center do dono, na fórmula da planilha dele ("Fechamento <empresa>", aba Fechamento), sem desvio.
 * É o número que ele fecha na mão com o Pagah, e o sistema passa a reproduzi-lo para conferir:
 *
 *   VENDAS = pedido com `origem` "Call" ou "Whats" (a `QUERY` dele), PAGO NO MÊS e ainda pago hoje (o export dele só traz
 *            pedido com status Pago): quem foi estornado ou virou chargeback no próprio mês some, sem entrar como venda
 *            nem como chargeback. Valor: cartão = `valor_sem_juros`; boleto e pix = `total_pedido` (colunas J e I).
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
  mes: string;
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
    /** vendas do mês, de origem Call/Whats, que o Pagah já mostra estornadas ou em chargeback: fora das duas pontas, como na planilha */
    revertidasNoMes: { pedidos: number; totalCentavos: number };
    /** pagas no mês e revertidas só depois dele: não entram agora (a planilha também as perde) e pesam no mês da reversão */
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

const dentro = (d: Date | null, a: Date, b: Date) => d !== null && d >= a && d < b;
const soma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function calcularFechamento(mes: string, vendas: ReadonlyArray<VendaDoFechamento>): FechamentoCallCenter {
  const { inicio, fim, de, ate } = limitesDoMes(mes);
  const foiRevertida = (v: VendaDoFechamento) => v.status === 'ESTORNADO' || v.status === 'CHARGEBACK';

  const noMes = vendas.filter((v) => dentro(v.pagoEm, inicio, fim));
  const semOrigem = noMes.filter((v) => v.status === 'PAGO' && !v.origem?.trim());
  const callNoMes = noMes.filter((v) => origemEhCallCenter(v.origem));

  const vendidas = callNoMes.filter((v) => v.status === 'PAGO');
  const revertidas = callNoMes.filter(foiRevertida);
  const revertidasNoMes = revertidas.filter((v) => dentro(v.perdaEm, inicio, fim));
  const revertidasDepois = revertidas.filter((v) => !dentro(v.perdaEm, inicio, fim));

  const chargebacks = vendas.filter(
    (v) => origemEhCallCenter(v.origem) && foiRevertida(v) && v.pagoEm !== null && v.pagoEm < inicio && dentro(v.perdaEm, inicio, fim),
  );

  const cbSemOrigem = vendas.filter(
    (v) => !v.origem?.trim() && foiRevertida(v) && v.pagoEm !== null && v.pagoEm < inicio && dentro(v.perdaEm, inicio, fim),
  );

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
