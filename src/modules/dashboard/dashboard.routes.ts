import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { Prisma } from '../../generated/prisma/client';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { serie } from '../../shared/repositories/ledger.repository';
import { ok } from '../../shared/utils/response';
import { tsz } from '../../shared/utils/sql';
import { comparativoHandler, construirAlertas, dimensaoHandler, formatar, metaFinanceira, relatorio } from '../../shared/services/relatorio.service';
import { filtrosBase, filtrosSchema, refinarPeriodo, resolverFiltro, type FiltrosQuery } from '../../shared/validators/filtros';
import { totais } from '../../shared/repositories/ledger.repository';
import { investimentoNoPeriodo } from '../../integrations/redtrack/redtrack.client';
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
/**
 * Investimento em tráfego (RedTrack) e ROAS TOTAL da operação = receita total de todos os grupos ÷ investimento.
 * Só o período vale aqui: os outros filtros (loja, grupo...) não se aplicam ao investimento, então também não entram na receita.
 */
dashboardRouter.get('/trafego', authorize(Roles.ANALISE), q, relatorio(async (f, req) => {
  const base = resolverFiltro(filtrosBase.parse({ de: req.valid.query.de, ate: req.valid.query.ate, modo: req.valid.query.modo }));
  const [inv, m] = await Promise.all([investimentoNoPeriodo(f.de, f.ate), totais(base)]);
  return {
    investimentoCentavos: inv.centavos,
    receitaTotalCentavos: m.receitaCentavos,
    roasTotalCentesimos: inv.centavos ? Math.round((m.receitaCentavos * 100) / inv.centavos) : null,
    fonteInvestimento: inv.fonte,
    mensagem: inv.centavos === null ? (inv.mensagem ?? null) : null,
  };
}));
dashboardRouter.get('/indicadores', q, relatorio((f, req) => indicadores(f, req)));

/**
 * Valores distintos para os filtros (loja, produto, origem, campanha, atendente) — só os NOMES, sem calcular métricas. Antes as listas dos
 * filtros eram montadas a partir dos relatórios completos (90–200 KB cada). Loja vale para qualquer perfil; as demais exigem ANALISTA+.
 */
export const opcoesQuery = filtrosBase.extend({ dim: z.enum(['loja', 'produto', 'origem', 'campanha', 'atendente']) }).superRefine(refinarPeriodo);
const EXPR_OPCAO = {
  loja: 'l.nome',
  produto: 'v."kitNome"',
  origem: 'v.origem',
  campanha: 'v.campanha',
  atendente: `COALESCE(v.atendente, CASE WHEN v."grupo" IN ('CALL_CENTER', 'RECUPERACAO') THEN v.subcanal END)`,
} as const;
dashboardRouter.get('/opcoes', validate({ query: opcoesQuery }), async (req, res) => {
  const q = req.valid.query as FiltrosQuery & { dim: keyof typeof EXPR_OPCAO };
  if (q.dim !== 'loja' && !(Roles.ANALISE as readonly string[]).includes(req.user!.perfil)) throw Errors.forbidden();
  const f = resolverFiltro(q);
  const expr = Prisma.raw(EXPR_OPCAO[q.dim]);
  const rows = await prisma.$queryRaw<{ v: string }[]>(Prisma.sql`
    SELECT DISTINCT ${expr} AS v
    FROM vendas v LEFT JOIN lojas l ON l.id = v."lojaId"
    WHERE v."pagoEm" >= ${tsz(f.deTs)} AND v."pagoEm" < ${tsz(f.ateTsExcl)} AND ${expr} IS NOT NULL
    ORDER BY 1 LIMIT 2000`);
  ok(res, rows.map((r) => r.v), await metaFinanceira(f));
});
