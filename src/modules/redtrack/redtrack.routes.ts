import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { Prisma } from '../../generated/prisma/client';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { totais } from '../../shared/repositories/ledger.repository';
import { wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import { dimensaoHandler, formatar, metaFinanceira, relatorio } from '../../shared/services/relatorio.service';
import { ok, pageMeta, paginated } from '../../shared/utils/response';
import { filtrosSchema, resolverFiltro, type FiltrosQuery } from '../../shared/validators/filtros';

export const redtrackRouter = Router();
redtrackRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });

export const redtrackQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  situacao: z.string().trim().max(100).optional(),
  campanha: z.string().trim().max(200).optional(),
  pedido: z.string().trim().max(60).optional(),
});

const rtSelect = { pedido: true, conversaoId: true, payoutCentavos: true, situacao: true, campanha: true, anuncio: true, vendaId: true, sincronizadoEm: true } as const;

redtrackRouter.get('/conversoes', validate({ query: redtrackQuery }), async (req, res) => {
  const { page, limit, situacao, campanha, pedido } = req.valid.query;
  const where = {
    ...(situacao ? { situacao } : {}),
    ...(campanha ? { campanha } : {}),
    ...(pedido ? { pedido } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.redtrackConversao.count({ where }),
    prisma.redtrackConversao.findMany({ where, select: rtSelect, orderBy: { sincronizadoEm: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  paginated(res, items, pageMeta(page, limit, total));
});

/** Cobertura da conciliação Pagah x RedTrack (relacionamento pelo número do pedido). */
redtrackRouter.get('/conciliacao', q, async (req, res) => {
  const f = resolverFiltro(req.valid.query as FiltrosQuery);
  const where = wherePagoNoPeriodo(f);
  const [vendas, comRedtrack, semVenda, porSituacao] = await Promise.all([
    prisma.venda.count({ where }),
    prisma.venda.count({ where: { ...where, redtrackConciliado: true } }),
    prisma.redtrackConversao.count({ where: { vendaId: null } }),
    prisma.redtrackConversao.groupBy({ by: ['situacao'], _count: { _all: true } }),
  ]);
  ok(
    res,
    {
      vendasNoPeriodo: vendas,
      vendasComRedtrack: comRedtrack,
      vendasSemRedtrack: vendas - comRedtrack,
      coberturaPercentual: vendas === 0 ? null : Math.round((comRedtrack / vendas) * 10000) / 100,
      conversoesSemVenda: semVenda,
      porSituacao: porSituacao.map((s) => ({ situacao: s.situacao, quantidade: s._count._all })),
      observacao: 'Nem toda venda precisa de conversão RedTrack (ex.: vendas sem campanha rastreada); use a cobertura como indicador, não como erro.',
    },
    await metaFinanceira(f),
  );
});

/** Divergências objetivas: conversão sem venda; payout diferente da comissão; situação diferente da maioria. */
redtrackRouter.get('/divergencias', validate({ query: redtrackQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const [total, rows] = await Promise.all([
    prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n FROM redtrack_conversoes r LEFT JOIN vendas v ON v.id = r."vendaId"
      WHERE r."vendaId" IS NULL OR (r."payoutCentavos" IS NOT NULL AND v."comissaoCentavos" IS NOT NULL AND NOT v.x1 AND r."payoutCentavos" <> v."comissaoCentavos")`),
    prisma.$queryRaw<
      { pedido: string; tipo: string; payout: number | null; liquido: number | null; situacao: string | null }[]
    >(Prisma.sql`
      SELECT r.pedido, CASE WHEN r."vendaId" IS NULL THEN 'SEM_VENDA' ELSE 'PAYOUT_DIFERENTE_DO_LIQUIDO' END AS tipo,
             r."payoutCentavos" AS payout, v."comissaoCentavos" AS liquido, r.situacao
      FROM redtrack_conversoes r LEFT JOIN vendas v ON v.id = r."vendaId"
      WHERE r."vendaId" IS NULL OR (r."payoutCentavos" IS NOT NULL AND v."comissaoCentavos" IS NOT NULL AND NOT v.x1 AND r."payoutCentavos" <> v."comissaoCentavos")
      ORDER BY r.pedido LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
  ]);
  paginated(
    res,
    rows.map((r) => ({ pedido: r.pedido, tipo: r.tipo, payoutCentavos: r.payout, liquidoReceberCentavos: r.liquido, situacao: r.situacao })),
    pageMeta(page, limit, Number(total[0]?.n ?? 0)),
  );
});

// ── campanhas (dados da aba REDTRACK + campanha informada em HISTORICO/EVENTOS)
export const campanhasRouter = Router();
campanhasRouter.use(authenticate(), authorize(Roles.ANALISE));

campanhasRouter.get('/', q, dimensaoHandler('campanha'));
campanhasRouter.get('/resumo', q, relatorio(async (f) => {
  const m = await totais(f);
  const comCampanha = await prisma.venda.count({ where: { ...wherePagoNoPeriodo(f), campanha: { not: null } } });
  const total = await prisma.venda.count({ where: wherePagoNoPeriodo(f) });
  return { ...formatar(m, f.modo), vendasComCampanha: comCampanha, vendasSemCampanha: total - comCampanha };
}));
campanhasRouter.get('/por-anuncio', q, dimensaoHandler('anuncio'));
campanhasRouter.get('/por-loja', q, dimensaoHandler('loja'));
