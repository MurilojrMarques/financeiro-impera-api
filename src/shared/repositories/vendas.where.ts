import type { Prisma } from '../../generated/prisma/client';
import type { FiltroResolvido } from '../validators/filtros';

/** Filtros de dimensão equivalentes aos do ledger, para listagens paginadas via Prisma. */
export function whereDimensoes(f: FiltroResolvido): Prisma.VendaWhereInput {
  return {
    ...(f.loja ? { loja: { nome: f.loja } } : {}),
    ...(f.produto ? { kitNome: f.produto } : {}),
    ...(f.grupo ? { grupo: f.grupo } : {}),
    ...(f.afiliadoId ? { afiliadoId: f.afiliadoId } : {}),
    ...(f.metodo ? { metodoPagamento: { equals: f.metodo, mode: 'insensitive' as const } } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.origem ? { origem: f.origem } : {}),
    ...(f.campanha ? { campanha: f.campanha } : {}),
    ...(f.anuncio ? { anuncio: f.anuncio } : {}),
    ...(f.tipo ? { tipoVenda: f.tipo === 'COMPRA' ? 'FRONT' : f.tipo } : {}),
  };
}

/** Vendas PAGAS no período (data do pagamento). */
export function wherePagoNoPeriodo(f: FiltroResolvido): Prisma.VendaWhereInput {
  return { ...whereDimensoes(f), pagoEm: { gte: f.deTs, lt: f.ateTsExcl } };
}

/** Vendas com perda (estorno/chargeback) reconhecida no período (data do evento). */
export function wherePerdaNoPeriodo(f: FiltroResolvido): Prisma.VendaWhereInput {
  return { ...whereDimensoes(f), perdaCentavos: { gt: 0 }, perdaEm: { gte: f.deTs, lt: f.ateTsExcl } };
}

export const vendaListSelect = {
  pedido: true,
  grupo: true,
  tipoVenda: true,
  status: true,
  kitNome: true,
  metodoPagamento: true,
  parcelas: true,
  valorTotalCentavos: true,
  valorVendaCentavos: true,
  jurosCentavos: true,
  comissaoCentavos: true,
  comissaoFonte: true,
  comissaoAfiliadoCentavos: true,
  comissaoAfiliadoFonte: true,
  taxaCallCenterCentavos: true,
  x1: true,
  origem: true,
  tipoAtendimento: true,
  atendente: true,
  campanha: true,
  anuncio: true,
  pagoEm: true,
  estornadoEm: true,
  chargebackEm: true,
  perdaCentavos: true,
  perdaTipo: true,
  perdaEm: true,
  avisos: true,
  fonteVerdade: true,
  loja: { select: { nome: true } },
  afiliado: { select: { id: true, nome: true } },
} satisfies Prisma.VendaSelect;

type VendaLista = Prisma.VendaGetPayload<{ select: typeof vendaListSelect }>;

/**
 * Serializa venda sem expor payload/dados pessoais. Comissão X1 aparece como 0 (regra padrão),
 * a menos que a visão administrativa explícita (`incluirX1`) tenha sido autorizada.
 */
export function serializarVenda(v: VendaLista, mostrarX1Real: boolean) {
  const { loja, afiliado, comissaoCentavos, ...resto } = v;
  const comissaoPadrao = v.x1 && !mostrarX1Real ? 0 : comissaoCentavos;
  return {
    ...resto,
    loja: loja?.nome ?? null,
    afiliado: afiliado ?? null,
    comissaoCentavos: comissaoPadrao,
    ...(v.x1 && !mostrarX1Real ? { comissaoX1Oculta: true } : {}),
  };
}
