import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { porDimensao, totais } from '../../shared/repositories/ledger.repository';
import { wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import {
  comparativoHandler, dimensaoHandler, forcarGrupo, formatar, lista, relatorio, serieHandler,
} from '../../shared/services/relatorio.service';
import { filtrosSchema, type FiltroResolvido } from '../../shared/validators/filtros';
import { listarVendas } from '../vendas/vendas.service';

export const frontRouter = Router();
frontRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });
const front = forcarGrupo('FRONT');
const frontTipo = (tipo: 'COMPRA' | 'UPSELL' | 'DOWNSELL') => (f: FiltroResolvido): FiltroResolvido => ({ ...f, grupo: 'FRONT', tipo });

/** Upsell% = pedidos de upsell / pedidos de compra inicial, MESMA loja, sem afiliados (Front já exclui afiliado e call center). */
async function conversaoUpsell(f: FiltroResolvido) {
  const [ups, compras] = await Promise.all([
    porDimensao(frontTipo('UPSELL')(f), 'loja'),
    porDimensao(frontTipo('COMPRA')(f), 'loja'),
  ]);
  const lojas = new Set([...ups.map((l) => l.chave), ...compras.map((l) => l.chave)]);
  const itens = [...lojas].map((loja) => {
    const u = ups.find((l) => l.chave === loja)?.pedidos ?? 0;
    const c = compras.find((l) => l.chave === loja)?.pedidos ?? 0;
    return { loja, pedidosUpsell: u, pedidosCompra: c, conversaoUpsellPercentual: c === 0 ? null : Math.round((u / c) * 10000) / 100 };
  });
  const totalU = itens.reduce((s, i) => s + i.pedidosUpsell, 0);
  const totalC = itens.reduce((s, i) => s + i.pedidosCompra, 0);
  return {
    geral: { pedidosUpsell: totalU, pedidosCompra: totalC, conversaoUpsellPercentual: totalC === 0 ? null : Math.round((totalU / totalC) * 10000) / 100 },
    porLoja: itens.sort((a, b) => b.pedidosCompra - a.pedidosCompra),
  };
}

frontRouter.get('/resumo', q, relatorio(async (f) => {
  const [m, compras, ups, downs, conv] = await Promise.all([
    totais(f),
    totais(frontTipo('COMPRA')(f)),
    totais(frontTipo('UPSELL')(f)),
    totais(frontTipo('DOWNSELL')(f)),
    conversaoUpsell(f),
  ]);
  return {
    ...formatar(m, f.modo),
    porTipo: { compras: formatar(compras, f.modo), upsells: formatar(ups, f.modo), downsells: formatar(downs, f.modo) },
    conversaoUpsell: conv.geral,
    unidades: { disponivel: false, motivo: 'unidades vendidas não existem na planilha' },
  };
}, front));

const listaFront = (ajuste: Parameters<typeof lista>[1]) =>
  lista((f, req) => listarVendas(f, wherePagoNoPeriodo(f), req), ajuste);

frontRouter.get('/vendas', q, listaFront(front));
frontRouter.get('/compras', q, listaFront(frontTipo('COMPRA')));
frontRouter.get('/upsells', q, listaFront(frontTipo('UPSELL')));
frontRouter.get('/downsells', q, listaFront(frontTipo('DOWNSELL')));
frontRouter.get('/conversao-upsell', q, relatorio(conversaoUpsell, front));
frontRouter.get('/por-loja', q, dimensaoHandler('loja', front));
frontRouter.get('/por-produto', q, dimensaoHandler('produto', front));
frontRouter.get('/por-campanha', q, dimensaoHandler('campanha', front));
frontRouter.get('/por-anuncio', q, dimensaoHandler('anuncio', front));
frontRouter.get('/evolucao', q, serieHandler('dia', front));
frontRouter.get('/comparativo', q, comparativoHandler(front));
