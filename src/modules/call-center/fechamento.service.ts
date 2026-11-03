import { prisma } from '../../config/database';
import { calcularFechamento, limitesDoMes, limitesDoPeriodo, type FechamentoCallCenter, type VendaDoFechamento } from './fechamento.domain';

/**
 * O fechamento do Call Center do mês na fórmula da planilha do dono (ver `fechamento.domain.ts`). Lê só os pedidos que
 * importam: pagos no mês, ou estornados/com chargeback no mês (para os pagos antes dele).
 */
export async function fechamentoCallCenter(alvo: string | { de: string; ate: string }, posicaoEm?: Date): Promise<FechamentoCallCenter> {
  const { inicio, fim } = typeof alvo === 'string' ? limitesDoMes(alvo) : limitesDoPeriodo(alvo.de, alvo.ate);
  const vendas = await vendasDoFechamento(inicio, fim);
  return calcularFechamento(alvo, vendas, posicaoEm);
}

/**
 * Os pedidos que importam ao período: pagos nele, ou revertidos nele (os pagos antes).
 *
 * A data de reversão que vale aqui é a da PRIMEIRA: o pedido que foi estornado em 26/10 e só virou chargeback em 03/11 já
 * estava devolvido em outubro. A `perdaEm` do pedido guarda o chargeback (regra do Elias: estorno + chargeback integrais são
 * uma perda só, e fica o chargeback), o que serve ao financeiro mas não a este fechamento, que pergunta "em que dia o pedido
 * deixou de valer".
 */
export async function vendasDoFechamento(inicio: Date, fim: Date): Promise<VendaDoFechamento[]> {
  const noPeriodo = { gte: inicio, lt: fim };
  const linhas = await prisma.venda.findMany({
    where: {
      OR: [
        { pagoEm: noPeriodo },
        { pagoEm: { lt: inicio }, OR: [{ estornadoEm: noPeriodo }, { chargebackEm: noPeriodo }, { perdaEm: noPeriodo }] },
      ],
    },
    select: {
      pedido: true, origem: true, status: true, metodoPagamento: true, parcelas: true, pagoEm: true, perdaEm: true,
      estornadoEm: true, chargebackEm: true, valorVendaCentavos: true, valorTotalCentavos: true, jurosCentavos: true,
    },
  });
  return linhas.map(({ estornadoEm, chargebackEm, ...v }) => {
    const datas = [estornadoEm, chargebackEm].filter((d): d is Date => d !== null);
    return { ...v, perdaEm: datas.length > 0 ? new Date(Math.min(...datas.map((d) => d.getTime()))) : v.perdaEm };
  });
}
