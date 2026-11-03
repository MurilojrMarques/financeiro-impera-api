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

/** Os pedidos que importam ao período: pagos nele, ou revertidos nele (os pagos antes). */
export async function vendasDoFechamento(inicio: Date, fim: Date): Promise<VendaDoFechamento[]> {
  return prisma.venda.findMany({
    where: { OR: [{ pagoEm: { gte: inicio, lt: fim } }, { perdaEm: { gte: inicio, lt: fim }, pagoEm: { lt: inicio } }] },
    select: {
      pedido: true, origem: true, status: true, metodoPagamento: true, parcelas: true, pagoEm: true, perdaEm: true,
      valorVendaCentavos: true, valorTotalCentavos: true, jurosCentavos: true,
    },
  });
}
