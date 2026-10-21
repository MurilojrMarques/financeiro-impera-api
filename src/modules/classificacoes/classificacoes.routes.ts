import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, noContent, ok } from '../../shared/utils/response';
import { GRUPOS, filtrosSchema, idUuidParams, resolverFiltro, type FiltrosQuery } from '../../shared/validators/filtros';
import { wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import { metaFinanceira } from '../../shared/services/relatorio.service';
import { listarRegras, reclassificarEmSegundoPlano, simularRegra } from './classificacoes.service';

export const classificacoesRouter = Router();
classificacoesRouter.use(authenticate());

const admin = authorize(Roles.ADMIN);

const campos = ['ORIGEM', 'TIPO_ATENDIMENTO', 'LOJA', 'CAMPANHA', 'UTM_SOURCE', 'SRC', 'CHECKOUT'] as const;
const operadores = ['IGUAL', 'CONTEM', 'COMECA_COM'] as const;

export const regraBody = z.object({
  nome: z.string().trim().min(2).max(120),
  campo: z.enum(campos),
  operador: z.enum(operadores),
  valor: z.string().trim().min(1).max(200),
  grupo: z.enum(GRUPOS),
  canal: z.string().trim().min(1).max(60).optional(),
  prioridade: z.number().int().min(1).max(10000).default(100),
  ativa: z.boolean().default(true),
});
export const patchBody = regraBody.partial().refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');
export const simularBody = z.object({
  regra: regraBody.pick({ campo: true, operador: true, valor: true, grupo: true, prioridade: true }),
  substituirRegraId: z.string().uuid().optional(),
  limite: z.number().int().min(1).max(50_000).default(10_000),
});

classificacoesRouter.get('/regras', authorize(Roles.FINANCEIRO), async (_req, res) => ok(res, await listarRegras()));

classificacoesRouter.post('/regras', admin, validate({ body: regraBody }), async (req, res) => {
  const r = await prisma.regraClassificacao.create({ data: { ...req.valid.body, criadoPorId: req.user!.id } });
  await audit(req, 'classificacao.regra_criada', 'regra_classificacao', r.id, req.valid.body);
  reclassificarEmSegundoPlano();
  created(res, r);
});

classificacoesRouter.patch('/regras/:id', admin, validate({ params: idUuidParams, body: patchBody }), async (req, res) => {
  const atual = await prisma.regraClassificacao.findUnique({ where: { id: req.valid.params.id } });
  if (!atual) throw Errors.notFound('Regra não encontrada');
  const r = await prisma.regraClassificacao.update({ where: { id: atual.id }, data: { ...req.valid.body, versao: { increment: 1 } } });
  await audit(req, 'classificacao.regra_atualizada', 'regra_classificacao', r.id, { antes: { ...atual }, depois: req.valid.body });
  reclassificarEmSegundoPlano();
  ok(res, r);
});

classificacoesRouter.delete('/regras/:id', admin, validate({ params: idUuidParams }), async (req, res) => {
  const atual = await prisma.regraClassificacao.findUnique({ where: { id: req.valid.params.id } });
  if (!atual) throw Errors.notFound('Regra não encontrada');
  await prisma.regraClassificacao.delete({ where: { id: atual.id } });
  await audit(req, 'classificacao.regra_removida', 'regra_classificacao', atual.id, { ...atual });
  reclassificarEmSegundoPlano();
  noContent(res);
});

/** Pendências: o que não pôde ser classificado, agregado pelos campos que poderiam sustentar uma regra. */
classificacoesRouter.get('/pendencias', authorize(Roles.ANALISE), validate({ query: filtrosSchema }), async (req, res) => {
  const f = resolverFiltro(req.valid.query as FiltrosQuery);
  const where = { ...wherePagoNoPeriodo(f), grupo: 'NAO_CLASSIFICADA' as const };
  const [total, agrupado] = await Promise.all([
    prisma.venda.count({ where }),
    prisma.venda.groupBy({
      by: ['tipoBruto', 'origem', 'tipoAtendimento'],
      where,
      _count: { _all: true },
      _sum: { valorVendaCentavos: true },
      orderBy: { _count: { tipoBruto: 'desc' } },
      take: 100,
    }),
  ]);
  ok(
    res,
    {
      totalPendentes: total,
      agrupamentos: agrupado.map((g) => ({
        tipoBruto: g.tipoBruto, origem: g.origem, tipoAtendimento: g.tipoAtendimento,
        pedidos: g._count._all, valorVendaCentavos: g._sum.valorVendaCentavos ?? 0,
      })),
      orientacao: 'Crie regras explícitas (POST /classificacoes/regras) com base nestes campos; use /classificacoes/simular antes.',
    },
    await metaFinanceira(f),
  );
});

classificacoesRouter.post('/simular', authorize(Roles.FINANCEIRO), validate({ body: simularBody }), async (req, res) => {
  const { regra, substituirRegraId, limite } = req.valid.body;
  ok(res, await simularRegra(regra, { substituirRegraId, limite }));
});
