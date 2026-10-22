import { comissaoDaVenda } from './domain/comissao';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../shared/errors/app-error';
import { vendaListSelect, serializarVenda, wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import { ordenacaoSegura, type FiltroResolvido } from '../../shared/validators/filtros';

const ORDENAVEIS = ['pagoEm', 'valorVendaCentavos', 'pedido', 'status', 'grupo', 'perdaEm'] as const;

/** X1 real só na visão administrativa explícita (?incluirX1=true) e para ADMIN/FINANCEIRO. */
export function podeVerX1(req: Request, f: FiltroResolvido): boolean {
  return f.incluirX1 === true && (req.user?.perfil === 'ADMIN' || req.user?.perfil === 'FINANCEIRO');
}

export async function listarVendas(f: FiltroResolvido, where: Prisma.VendaWhereInput, req: Request) {
  const campo = ordenacaoSegura(f.sortBy, ORDENAVEIS, 'pagoEm');
  const direcao = f.sortOrder === 'ASC' ? 'asc' : 'desc';
  const [total, rows] = await Promise.all([
    prisma.venda.count({ where }),
    prisma.venda.findMany({
      where,
      select: vendaListSelect,
      orderBy: [{ [campo]: direcao }, { pedido: 'asc' }],
      skip: (f.page - 1) * f.limit,
      take: f.limit,
    }),
  ]);
  const ver = podeVerX1(req, f);
  return { total, items: rows.map((r) => serializarVenda(r, ver)) };
}

export const listarVendasPagas = (f: FiltroResolvido, req: Request) => listarVendas(f, wherePagoNoPeriodo(f), req);

export async function obterVenda(pedido: string, req: Request, f: FiltroResolvido) {
  const v = await prisma.venda.findUnique({ where: { pedido }, select: vendaListSelect });
  if (!v) throw Errors.notFound('Pedido não encontrado');
  return serializarVenda(v, podeVerX1(req, f));
}

export async function eventosDaVenda(pedido: string) {
  const venda = await prisma.venda.findUnique({ where: { pedido }, select: { id: true } });
  if (!venda) throw Errors.notFound('Pedido não encontrado');
  return prisma.vendaEvento.findMany({
    where: { vendaId: venda.id },
    select: { tipo: true, fonte: true, ocorridoEm: true, recebidoEm: true, valorCentavos: true, linhaOrigem: true, criadoEm: true },
    orderBy: [{ ocorridoEm: 'asc' }, { criadoEm: 'asc' }],
  });
}

/** Rastreabilidade: de onde veio cada valor do pedido (sem payload bruto nem dados pessoais). */
export async function conciliacaoDaVenda(pedido: string, verX1: boolean) {
  const v = await prisma.venda.findUnique({
    where: { pedido },
    select: {
      pedido: true, fonteVerdade: true, comissaoFonte: true, comissaoCentavos: true, x1: true,
      grupo: true, classificacaoMotivo: true, classificacaoRegraId: true, status: true,
      valorVendaCentavos: true, valorTotalCentavos: true, jurosCentavos: true,
      perdaCentavos: true, perdaTipo: true, perdaEm: true, avisos: true, redtrackConciliado: true, sincronizadoEm: true,
      eventos: { select: { tipo: true, fonte: true, ocorridoEm: true, valorCentavos: true, linhaOrigem: true }, orderBy: { ocorridoEm: 'asc' } },
      redtrack: { select: { situacao: true, payoutCentavos: true, campanha: true, anuncio: true, sincronizadoEm: true } },
    },
  });
  if (!v) throw Errors.notFound('Pedido não encontrado');
  const comissaoDivergente =
    !v.x1 && v.redtrack?.payoutCentavos != null && v.comissaoCentavos != null && v.redtrack.payoutCentavos !== v.comissaoCentavos;
  return {
    pedido: v.pedido,
    fonteDosAtributos: v.fonteVerdade,
    valores: { vendaCentavos: v.valorVendaCentavos, totalCentavos: v.valorTotalCentavos, jurosCentavos: v.jurosCentavos, base: 'valor_sem_juros' },
    comissao: { fonte: v.comissaoFonte, x1: v.x1, centavos: comissaoDaVenda(v.grupo, v.valorVendaCentavos), regra: 'Call Center = 20% do valor vendido; demais grupos em implementação' },
    classificacao: { grupo: v.grupo, motivo: v.classificacaoMotivo, regraId: v.classificacaoRegraId },
    perda: { centavos: v.perdaCentavos, tipo: v.perdaTipo, em: v.perdaEm, status: v.status },
    eventos: v.eventos,
    redtrack: v.redtrack ? { ...v.redtrack, comissaoDivergente } : null,
    avisos: v.avisos,
    sincronizadoEm: v.sincronizadoEm,
  };
}
