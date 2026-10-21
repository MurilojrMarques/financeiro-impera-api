import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { ok } from '../../shared/utils/response';
import { dimensaoHandler, lista, metaFinanceira, resumoHandler, serieHandler } from '../../shared/services/relatorio.service';
import { filtrosSchema, pedidoParams, resolverFiltro, type FiltrosQuery } from '../../shared/validators/filtros';
import { conciliacaoDaVenda, eventosDaVenda, listarVendasPagas, obterVenda, podeVerX1 } from './vendas.service';

export const vendasRouter = Router();
vendasRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });

// rotas estáticas ANTES das dinâmicas (/:pedido)
vendasRouter.get('/', q, lista((f, req) => listarVendasPagas(f, req)));
vendasRouter.get('/resumo', q, resumoHandler());
vendasRouter.get('/por-dia', q, serieHandler('dia'));
vendasRouter.get('/por-hora', q, serieHandler('hora'));
vendasRouter.get('/por-semana', q, serieHandler('semana'));
vendasRouter.get('/por-loja', q, dimensaoHandler('loja'));
vendasRouter.get('/por-produto', q, dimensaoHandler('produto'));
vendasRouter.get('/por-metodo', q, dimensaoHandler('metodo'));
vendasRouter.get('/por-status', q, dimensaoHandler('status'));
vendasRouter.get('/por-origem', q, dimensaoHandler('origem'));

vendasRouter.get('/:pedido', validate({ params: pedidoParams, query: filtrosSchema }), async (req, res) => {
  const f = resolverFiltro(req.valid.query as FiltrosQuery);
  ok(res, await obterVenda(req.valid.params.pedido, req, f), await metaFinanceira(f));
});

vendasRouter.get('/:pedido/eventos', validate({ params: pedidoParams }), async (req, res) => {
  ok(res, await eventosDaVenda(req.valid.params.pedido));
});

vendasRouter.get('/:pedido/conciliacao', validate({ params: pedidoParams, query: filtrosSchema }), async (req, res) => {
  const f = resolverFiltro(req.valid.query as FiltrosQuery);
  ok(res, await conciliacaoDaVenda(req.valid.params.pedido, podeVerX1(req, f)));
});
