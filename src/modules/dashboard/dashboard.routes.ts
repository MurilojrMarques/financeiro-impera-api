import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { serie } from '../../shared/repositories/ledger.repository';
import { comparativoHandler, construirAlertas, dimensaoHandler, formatar, relatorio } from '../../shared/services/relatorio.service';
import { filtrosBase, filtrosSchema, refinarPeriodo, type FiltrosQuery } from '../../shared/validators/filtros';
import { totais } from '../../shared/repositories/ledger.repository';
import { distribuicaoReceitas, indicadores, kpis, receitasPorGrupo } from './dashboard.service';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate(), authorize(Roles.LEITURA));

const q = validate({ query: filtrosSchema });
export const evolucaoQuery = filtrosBase
  .extend({ agrupamento: z.enum(['dia', 'semana', 'mes']).default('dia') })
  .superRefine(refinarPeriodo);

dashboardRouter.get('/resumo', q, relatorio(async (f, req) => {
  const [k, g, m] = await Promise.all([kpis(f, req), receitasPorGrupo(f), totais(f)]);
  return { kpis: k, receitasPorGrupo: g, alertas: await construirAlertas(f, m) };
}));
dashboardRouter.get('/kpis', q, relatorio((f, req) => kpis(f, req)));
dashboardRouter.get('/evolucao', validate({ query: evolucaoQuery }), relatorio(async (f, req) => {
  const bucket = (req.valid.query as FiltrosQuery & { agrupamento: 'dia' | 'semana' | 'mes' }).agrupamento;
  return (await serie(f, bucket)).map(({ periodo, ...m }) => ({ periodo, ...formatar(m, f.modo) }));
}));
dashboardRouter.get('/comparativo', q, comparativoHandler());
dashboardRouter.get('/distribuicao-receitas', q, relatorio((f) => distribuicaoReceitas(f)));
dashboardRouter.get('/receitas-por-grupo', q, relatorio((f) => receitasPorGrupo(f)));
dashboardRouter.get('/receitas-por-loja', q, dimensaoHandler('loja'));
dashboardRouter.get('/indicadores', q, relatorio((f, req) => indicadores(f, req)));
