import { prisma } from '../../config/database';
import { businessDateString } from '../../shared/utils/dates';
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

/** Mês comercial: o salário é dividido em 30 dias, em qualquer mês. */
export const DIAS_DO_MES_COMERCIAL = 30;

/**
 * Dias a pagar no mês, para quem entrou ou saiu no meio dele (mês comercial de 30 dias):
 *  - trabalhou o mês inteiro => 30 (salário cheio, também em fevereiro);
 *  - senão, os dias corridos entre a entrada (ou dia 1) e a saída (ou último dia), inclusive, no máximo 30;
 *  - fora do vínculo no mês => 0.
 */
export function diasTrabalhadosNoMes(competencia: string, inicio: Date | null, demissao: Date | null): number {
  const { inicio: ini, fim } = limitesDoMes(competencia);
  const de = inicio && inicio.getTime() > ini.getTime() ? inicio : ini;
  const ate = demissao && demissao.getTime() < fim.getTime() ? demissao : fim;
  if (ate.getTime() < de.getTime()) return 0;
  if (de.getTime() === ini.getTime() && ate.getTime() === fim.getTime()) return DIAS_DO_MES_COMERCIAL;
  const dias = Math.round((ate.getTime() - de.getTime()) / 86_400_000) + 1;
  return Math.min(dias, DIAS_DO_MES_COMERCIAL);
}

/** salário ÷ 30 × dias trabalhados, arredondado ao centavo. */
export const salarioProporcional = (mensalCentavos: number, dias: number): number => Math.round((mensalCentavos * dias) / DIAS_DO_MES_COMERCIAL);

/** salário + comissão + bônus − desconto − ImperaCred (o adiantamento do mês anterior). */
export const totalDoItem = (i: { salarioCentavos: number; comissaoCentavos: number; bonusCentavos: number; descontoCentavos: number; imperaCredCentavos: number }): number =>
  i.salarioCentavos + i.comissaoCentavos + i.bonusCentavos - i.descontoCentavos - i.imperaCredCentavos;

const mesComDeslocamento = (competencia: string, meses: number): string => {
  const [a, m] = competencia.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(a, m - 1 + meses, 1)).toISOString().slice(0, 7);
};
export const competenciaSeguinte = (competencia: string): string => mesComDeslocamento(competencia, 1);
export const competenciaAnterior = (competencia: string): string => mesComDeslocamento(competencia, -1);

/** O que cada colaborador adiantou (ImperaCred) no mês anterior: é o que a folha de `competencia` desconta. */
export async function imperaCredDoDesconto(competencia: string, colaboradorIds?: string[]): Promise<Map<string, number>> {
  const r = await prisma.rhImperaCred.groupBy({
    by: ['colaboradorId'],
    where: { competencia: competenciaAnterior(competencia), ...(colaboradorIds ? { colaboradorId: { in: colaboradorIds } } : {}) },
    _sum: { valorCentavos: true },
  });
  return new Map(r.map((x) => [x.colaboradorId, x._sum.valorCentavos ?? 0]));
}

/**
 * Depois de lançar ou apagar um ImperaCred: a folha do mês seguinte (se já existir e estiver ABERTA) passa a descontar o valor certo dessa pessoa.
 * Folha que ainda não existe pega o valor ao ser gerada; folha fechada nunca é tocada (a rota barra antes).
 */
export async function aplicarImperaCredNaFolha(competenciaDoDesconto: string, colaboradorId: string): Promise<void> {
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia: competenciaDoDesconto } });
  if (!folha || folha.status !== 'ABERTA') return;
  const item = await prisma.rhFolhaItem.findFirst({ where: { competenciaId: folha.id, colaboradorId } });
  if (!item) return;
  const valor = (await imperaCredDoDesconto(competenciaDoDesconto, [colaboradorId])).get(colaboradorId) ?? 0;
  if (valor === item.imperaCredCentavos) return;
  await prisma.rhFolhaItem.update({ where: { id: item.id }, data: { imperaCredCentavos: valor, totalCentavos: totalDoItem({ ...item, imperaCredCentavos: valor }) } });
}

/** Quem estava na folha do mês: começou até o fim do mês e não saiu antes do início dele. */
export async function colaboradoresDoMes(competencia: string) {
  const { inicio, fim } = limitesDoMes(competencia);
  return prisma.rhColaborador.findMany({
    where: { AND: [{ OR: [{ inicio: null }, { inicio: { lte: fim } }] }, { OR: [{ demissao: null }, { demissao: { gte: inicio } }] }] },
    select: { id: true, nome: true, salarioCentavos: true, inicio: true, demissao: true, movimentacoes: { select: { data: true, salarioAnteriorCentavos: true, salarioNovoCentavos: true } } },
    orderBy: { nome: 'asc' },
  });
}

/** Cálculo de uma linha da folha: salário vigente no fim do mês, dias trabalhados (mês comercial) e valor proporcional. */
export function calculoDoItem(
  competencia: string,
  p: { salarioCentavos: number; inicio: Date | null; demissao: Date | null; movimentacoes: Pick<RhMovimentacao, 'data' | 'salarioAnteriorCentavos' | 'salarioNovoCentavos'>[] },
) {
  const mensal = salarioNaData(p.salarioCentavos, p.movimentacoes, limitesDoMes(competencia).fim);
  const dias = diasTrabalhadosNoMes(competencia, p.inicio, p.demissao);
  return { salarioMensalCentavos: mensal, diasTrabalhados: dias, salarioCentavos: salarioProporcional(mensal, dias) };
}

/**
 * Quando a origem muda um salário, a folha do mês corrente (se ainda ABERTA) acompanha: refaz salário e dias dessas pessoas e mantém
 * comissão, bônus, desconto e pagamento. Folha fechada nunca é tocada. Devolve quantos itens mudaram.
 */
export async function recalcularFolhaAbertaDoMes(colaboradorIds: string[]): Promise<number> {
  if (colaboradorIds.length === 0) return 0;
  const competencia = businessDateString(new Date()).slice(0, 7);
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia } });
  if (!folha || folha.status !== 'ABERTA') return 0;
  const itens = await prisma.rhFolhaItem.findMany({ where: { competenciaId: folha.id, colaboradorId: { in: colaboradorIds } } });
  if (itens.length === 0) return 0;
  const pessoas = await prisma.rhColaborador.findMany({
    where: { id: { in: itens.map((i) => i.colaboradorId) } },
    select: { id: true, salarioCentavos: true, inicio: true, demissao: true, movimentacoes: { select: { data: true, salarioAnteriorCentavos: true, salarioNovoCentavos: true } } },
  });
  let mudou = 0;
  for (const p of pessoas) {
    const item = itens.find((i) => i.colaboradorId === p.id)!;
    const c = calculoDoItem(competencia, p);
    if (c.salarioCentavos === item.salarioCentavos && c.diasTrabalhados === item.diasTrabalhados && c.salarioMensalCentavos === item.salarioMensalCentavos) continue;
    mudou++;
    await prisma.rhFolhaItem.update({ where: { id: item.id }, data: { ...c, totalCentavos: totalDoItem({ ...c, comissaoCentavos: item.comissaoCentavos, bonusCentavos: item.bonusCentavos, descontoCentavos: item.descontoCentavos, imperaCredCentavos: item.imperaCredCentavos }) } });
  }
  return mudou;
}
