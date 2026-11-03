import { prisma } from '../../config/database';
import { calcularFechamento, limitesDoMes, type FechamentoCallCenter } from './fechamento.domain';

/**
 * O fechamento do Call Center do mês na fórmula da planilha do dono (ver `fechamento.domain.ts`). Lê só os pedidos que
 * importam: pagos no mês, ou estornados/com chargeback no mês (para os pagos antes dele).
 */
export async function fechamentoCallCenter(mes: string): Promise<FechamentoCallCenter> {
  const { inicio, fim } = limitesDoMes(mes);
  const vendas = await prisma.venda.findMany({
    where: { OR: [{ pagoEm: { gte: inicio, lt: fim } }, { perdaEm: { gte: inicio, lt: fim }, pagoEm: { lt: inicio } }] },
    select: {
      pedido: true, origem: true, status: true, metodoPagamento: true, parcelas: true, pagoEm: true, perdaEm: true,
      valorVendaCentavos: true, valorTotalCentavos: true, jurosCentavos: true,
    },
  });
  return calcularFechamento(mes, vendas);
}
