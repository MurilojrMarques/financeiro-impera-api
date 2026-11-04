import { prisma } from '../../config/database';
import { calcularFechamento, competenciaDoAlvo, limitesDoMes, limitesDoPeriodo, type AjusteDoFechamento, type FechamentoCallCenter, type VendaDoFechamento } from './fechamento.domain';

/**
 * O fechamento do Call Center do mês na fórmula da planilha de fechamento (ver `fechamento.domain.ts`). Lê só os pedidos que
 * importam: pagos no mês, ou estornados/com chargeback no mês (para os pagos antes dele).
 */
export interface PosicaoDoFechamento {
  /** AAAA-MM-DD: "como estavam os pedidos no começo deste dia"; nulo = fim do período */
  em: string | null;
  /** `FECHAMENTO`: o financeiro fechou o mês nessa data; `INFORMADA`: pedida na consulta; `FIM_DO_PERIODO`: o padrão */
  fonte: 'FECHAMENTO' | 'INFORMADA' | 'FIM_DO_PERIODO';
}

/**
 * A posição que vale: a pedida na consulta, senão a data em que o financeiro FECHOU a competência (mês inteiro), senão o fim do
 * período. A posição fechada faz a tela e a API mostrarem sempre o mesmo número, o da foto do dia do fechamento.
 */
export async function posicaoDoFechamento(competencia: string | null, informada?: Date): Promise<PosicaoDoFechamento & { data?: Date }> {
  if (informada) return { em: informada.toISOString().slice(0, 10), fonte: 'INFORMADA', data: informada };
  if (competencia) {
    const f = await prisma.fechamentoPosicao.findUnique({ where: { competencia }, select: { posicao: true } });
    if (f) return { em: f.posicao, fonte: 'FECHAMENTO', data: new Date(`${f.posicao}T00:00:00-03:00`) };
  }
  return { em: null, fonte: 'FIM_DO_PERIODO' };
}

export async function fechamentoCallCenter(
  alvo: string | { de: string; ate: string },
  posicaoEm?: Date,
): Promise<FechamentoCallCenter & { posicao: PosicaoDoFechamento }> {
  const { inicio, fim } = typeof alvo === 'string' ? limitesDoMes(alvo) : limitesDoPeriodo(alvo.de, alvo.ate);
  const competencia = competenciaDoAlvo(alvo);
  const ajustes = await ajustesDaCompetencia(competencia);
  const posicao = await posicaoDoFechamento(competencia, posicaoEm);
  const vendas = await vendasDoFechamento(inicio, fim, ajustes.map((a) => a.pedido));
  return { ...calcularFechamento(alvo, vendas, posicao.data, ajustes), posicao: { em: posicao.em, fonte: posicao.fonte } };
}

/** Os ajustes manuais da competência (só quando o pedido é o mês inteiro; período livre não os recebe). */
export async function ajustesDaCompetencia(competencia: string | null): Promise<AjusteDoFechamento[]> {
  if (!competencia) return [];
  const linhas = await prisma.fechamentoAjuste.findMany({ where: { competencia }, select: { pedido: true, acao: true, motivo: true, valorCentavos: true }, orderBy: { criadoEm: 'asc' } });
  return linhas;
}

/**
 * Os pedidos que importam ao período: pagos nele, ou revertidos nele (os pagos antes).
 *
 * A data de reversão que vale aqui é a da PRIMEIRA: o pedido que foi estornado em 26/10 e só virou chargeback em 03/11 já
 * estava devolvido em outubro. A `perdaEm` do pedido guarda o chargeback (regra do Elias: estorno + chargeback integrais são
 * uma perda só, e fica o chargeback), o que serve ao financeiro mas não a este fechamento, que pergunta "em que dia o pedido
 * deixou de valer".
 */
export async function vendasDoFechamento(inicio: Date, fim: Date, pedidosAjustados: string[] = []): Promise<VendaDoFechamento[]> {
  const noPeriodo = { gte: inicio, lt: fim };
  const linhas = await prisma.venda.findMany({
    where: {
      OR: [
        ...(pedidosAjustados.length > 0 ? [{ pedido: { in: pedidosAjustados } }] : []),
        { pagoEm: noPeriodo },
        {
          OR: [{ pagoEm: { lt: inicio } }, { criadoEmOrigem: { lt: inicio } }],
          AND: [{ OR: [{ estornadoEm: noPeriodo }, { chargebackEm: noPeriodo }, { perdaEm: noPeriodo }] }],
        },
      ],
    },
    select: {
      pedido: true, origem: true, status: true, metodoPagamento: true, parcelas: true, pagoEm: true, perdaEm: true,
      estornadoEm: true, chargebackEm: true, valorVendaCentavos: true, valorTotalCentavos: true, jurosCentavos: true,
      grupo: true, criadoEmOrigem: true,
    },
  });
  return linhas.map(({ estornadoEm, chargebackEm, criadoEmOrigem, ...v }) => {
    const datas = [estornadoEm, chargebackEm].filter((d): d is Date => d !== null);
    return { ...v, criadoEm: criadoEmOrigem, reversoesEm: datas.length > 0 ? datas : v.perdaEm ? [v.perdaEm] : [], perdaEm: datas.length > 0 ? new Date(Math.min(...datas.map((d) => d.getTime()))) : v.perdaEm };
  });
}
