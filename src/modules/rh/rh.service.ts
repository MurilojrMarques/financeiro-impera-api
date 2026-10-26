import { prisma } from '../../config/database';
import type { RhMovimentacao } from '../../generated/prisma/client';

/** Primeiro e último dia do mês (AAAA-MM), como datas UTC. */
export function limitesDoMes(competencia: string): { inicio: Date; fim: Date } {
  const [a, m] = competencia.split('-').map(Number) as [number, number];
  return { inicio: new Date(Date.UTC(a, m - 1, 1)), fim: new Date(Date.UTC(a, m, 0)) };
}

/**
 * Salário vigente numa data, pelo histórico: o último reajuste até a data; se a data for anterior a todos, o salário ANTERIOR ao primeiro
 * reajuste; sem histórico, o salário atual.
 */
export function salarioNaData(
  atualCentavos: number,
  movs: Pick<RhMovimentacao, 'data' | 'salarioAnteriorCentavos' | 'salarioNovoCentavos'>[],
  ate: Date,
): number {
  if (movs.length === 0) return atualCentavos;
  const ordenadas = [...movs].sort((a, b) => a.data.getTime() - b.data.getTime());
  const ateAgora = ordenadas.filter((m) => m.data.getTime() <= ate.getTime());
  if (ateAgora.length > 0) return ateAgora[ateAgora.length - 1]!.salarioNovoCentavos;
  return ordenadas[0]!.salarioAnteriorCentavos;
}

export const totalDoItem = (i: { salarioCentavos: number; comissaoCentavos: number; bonusCentavos: number; descontoCentavos: number }): number =>
  i.salarioCentavos + i.comissaoCentavos + i.bonusCentavos - i.descontoCentavos;

/** Quem estava na folha do mês: começou até o fim do mês e não saiu antes do início dele. */
export async function colaboradoresDoMes(competencia: string) {
  const { inicio, fim } = limitesDoMes(competencia);
  return prisma.rhColaborador.findMany({
    where: { AND: [{ OR: [{ inicio: null }, { inicio: { lte: fim } }] }, { OR: [{ demissao: null }, { demissao: { gte: inicio } }] }] },
    select: { id: true, nome: true, salarioCentavos: true, movimentacoes: { select: { data: true, salarioAnteriorCentavos: true, salarioNovoCentavos: true } } },
    orderBy: { nome: 'asc' },
  });
}
