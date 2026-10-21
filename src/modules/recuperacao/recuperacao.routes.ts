import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import { comparativoHandler, dimensaoHandler, forcarGrupo, lista, resumoHandler, serieHandler } from '../../shared/services/relatorio.service';
import { filtrosSchema } from '../../shared/validators/filtros';
import { listarVendas } from '../vendas/vendas.service';

/**
 * Recuperação de vendas: time interno (Pedro, Edinalva, vendedores internos e CS) que vende SEM a taxa de 20% do call center,
 * ou vende por link de vendedor no site. O grupo vem da coluna `canal` da planilha; o vendedor é o `subcanal`.
 */
export const recuperacaoRouter = Router();
recuperacaoRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });
const rec = forcarGrupo('RECUPERACAO');

recuperacaoRouter.get('/resumo', q, resumoHandler(rec));
recuperacaoRouter.get('/vendas', q, lista((f, req) => listarVendas(f, wherePagoNoPeriodo(f), req), rec));
recuperacaoRouter.get('/por-vendedor', q, dimensaoHandler('atendente', rec));
recuperacaoRouter.get('/por-loja', q, dimensaoHandler('loja', rec));
recuperacaoRouter.get('/por-produto', q, dimensaoHandler('produto', rec));
recuperacaoRouter.get('/por-metodo', q, dimensaoHandler('metodo', rec));
recuperacaoRouter.get('/evolucao', q, serieHandler('dia', rec));
recuperacaoRouter.get('/comparativo', q, comparativoHandler(rec));
