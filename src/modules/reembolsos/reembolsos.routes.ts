import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { totais } from '../../shared/repositories/ledger.repository';
import { wherePagoNoPeriodo, wherePerdaNoPeriodo } from '../../shared/repositories/vendas.where';
import { dimensaoHandler, formatar, lista, relatorio, serieHandler } from '../../shared/services/relatorio.service';
import { filtrosSchema, type FiltroResolvido } from '../../shared/validators/filtros';
import { listarVendas } from '../vendas/vendas.service';

export const reembolsosRouter = Router();
reembolsosRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });

/** MOVIMENTACAO: perdas reconhecidas no período (data do evento). APROVADAS: pedidos pagos no período hoje perdidos. */
const whereReembolso = (f: FiltroResolvido, tipo?: 'ESTORNO' | 'CHARGEBACK') => ({
  ...(f.modo === 'MOVIMENTACAO' ? wherePerdaNoPeriodo(f) : { ...wherePagoNoPeriodo(f), perdaCentavos: { gt: 0 } }),
  ...(tipo ? { perdaTipo: tipo } : {}),
});

reembolsosRouter.get('/', q, lista((f, req) => listarVendas(f, whereReembolso(f), req)));
reembolsosRouter.get('/estornos', q, lista((f, req) => listarVendas(f, whereReembolso(f, 'ESTORNO'), req)));
reembolsosRouter.get('/chargebacks', q, lista((f, req) => listarVendas(f, whereReembolso(f, 'CHARGEBACK'), req)));

reembolsosRouter.get('/resumo', q, relatorio(async (f) => {
  const m = await totais(f);
  const base = whereReembolso(f);
  const [duplos, semData] = await Promise.all([
    // pedidos com estorno E chargeback preservados como eventos, mas perda contada uma única vez
    prisma.venda.count({
      where: { ...base, estornadoEm: { not: null }, chargebackEm: { not: null } },
    }),
    prisma.venda.count({ where: { ...wherePagoNoPeriodo(f), perdaCentavos: { gt: 0 }, perdaEm: null } }),
  ]);
  return {
    ...formatar(m, f.modo),
    perdaTotalCentavos: m.estornosCentavos + m.chargebacksCentavos,
    pedidosComEstornoEChargeback: duplos,
    perdasSemData: semData,
    limitacoes: [
      'Perda integral de um pedido é contada uma única vez, mesmo com estorno e chargeback; os dois eventos permanecem auditáveis.',
      'Reembolsos Pix que não chegam pelo webhook Pagah não são conhecidos por esta API e não são estimados.',
    ],
  };
}));

reembolsosRouter.get('/por-loja', q, dimensaoHandler('loja'));
reembolsosRouter.get('/por-grupo', q, dimensaoHandler('grupo'));
reembolsosRouter.get('/evolucao', q, serieHandler('dia'));
