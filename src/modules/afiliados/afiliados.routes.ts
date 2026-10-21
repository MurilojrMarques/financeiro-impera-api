import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { porDimensao, ticketMedio, totais, type LinhaDimensao } from '../../shared/repositories/ledger.repository';
import { wherePagoNoPeriodo, wherePerdaNoPeriodo } from '../../shared/repositories/vendas.where';
import { audit } from '../../shared/services/audit.service';
import {
  comparativoHandler, dimensaoHandler, forcarGrupo, formatar, lista, metaFinanceira, relatorio, serieHandler,
} from '../../shared/services/relatorio.service';
import { created, noContent, ok, pageMeta, paginated } from '../../shared/utils/response';
import { searchKey } from '../../shared/utils/text';
import { filtrosBase, filtrosSchema, idUuidParams, refinarPeriodo, resolverFiltro, type FiltroResolvido, type FiltrosQuery } from '../../shared/validators/filtros';
import { listarVendas } from '../vendas/vendas.service';
import {
  adicionarAlias, criarRegraComissao, listarAliases, listarRegrasComissao, obterAfiliado, removerAlias,
} from './afiliados.service';

export const afiliadosRouter = Router();
afiliadosRouter.use(authenticate());

const ver: RequestHandler = authorize(Roles.ANALISE);
const admin: RequestHandler = authorize(Roles.ADMIN);
const financeiro: RequestHandler = authorize(Roles.FINANCEIRO);

export const afiliadosQuery = filtrosBase.extend({ nome: z.string().trim().min(1).max(120).optional() }).superRefine(refinarPeriodo);
const q = validate({ query: filtrosSchema });
const qNome = validate({ query: afiliadosQuery });
const idQ = validate({ params: idUuidParams, query: filtrosSchema });
const aliasParams = z.object({ id: z.string().uuid(), aliasId: z.string().uuid() });

const soAfiliados = forcarGrupo('AFILIADO');

/** Formato do dashboard: um item por afiliado. */
function itemAfiliado(l: LinhaDimensao, modo: FiltroResolvido['modo']) {
  return {
    id: l.id,
    nome: l.chave,
    pedidos: l.pedidos,
    faturamentoCentavos: l.brutoCentavos,
    receitaLiquidaCentavos: l.receitaCentavos,
    // comissão do AFILIADO (a que ele recebe); a da operação (o que a Impera recebe) vai em campo separado
    comissaoCentavos: l.comissaoAfiliadoCentavos,
    comissaoOperacaoCentavos: l.comissaoCentavos,
    reembolsosCentavos: l.estornosCentavos + l.chargebacksCentavos,
    ticketMedioCentavos: ticketMedio(l, modo),
  };
}

// ── estáticas antes de /:id
afiliadosRouter.get('/', ver, qNome, async (req, res) => {
  const query = req.valid.query as FiltrosQuery & { nome?: string };
  const f = { ...resolverFiltro(query), grupo: 'AFILIADO' as const };
  let linhas = (await porDimensao(f, 'afiliado', 1000)).filter((l) => l.id);
  if (query.nome) {
    const k = searchKey(query.nome)!;
    linhas = linhas.filter((l) => searchKey(l.chave)?.includes(k));
  }
  const total = linhas.length;
  const pagina = linhas.slice((f.page - 1) * f.limit, f.page * f.limit).map((l) => itemAfiliado(l, f.modo));
  paginated(res, pagina, pageMeta(f.page, f.limit, total), await metaFinanceira(f));
});

afiliadosRouter.get('/resumo', ver, q, relatorio(async (f) => {
  const [m, linhas] = await Promise.all([totais(f), porDimensao(f, 'afiliado', 1000)]);
  return { ...formatar(m, f.modo), afiliadosAtivos: linhas.filter((l) => l.id && l.pedidos > 0).length };
}, soAfiliados));

afiliadosRouter.get('/ranking', ver, q, relatorio(async (f) => {
  const linhas = (await porDimensao(f, 'afiliado', 1000)).filter((l) => l.id);
  return linhas.slice(0, Math.min(f.limit, 50)).map((l, i) => ({ posicao: i + 1, ...itemAfiliado(l, f.modo) }));
}, soAfiliados));

afiliadosRouter.get('/evolucao', ver, q, serieHandler('dia', soAfiliados));
afiliadosRouter.get('/por-loja', ver, q, dimensaoHandler('loja', soAfiliados));
afiliadosRouter.get('/comparativo', ver, q, comparativoHandler(soAfiliados));

// ── por afiliado
afiliadosRouter.get('/:id', ver, validate({ params: idUuidParams }), async (req, res) => ok(res, await obterAfiliado(req.valid.params.id)));

const doAfiliadoReq = (f: FiltroResolvido, req: Request): FiltroResolvido => ({
  ...f,
  grupo: 'AFILIADO',
  afiliadoId: req.valid.params.id,
});

afiliadosRouter.get('/:id/resumo', ver, idQ, relatorio(async (f) => {
  const m = await totais(f);
  return { ...formatar(m, f.modo), reembolsosCentavos: m.estornosCentavos + m.chargebacksCentavos };
}, doAfiliadoReq));

afiliadosRouter.get('/:id/vendas', ver, idQ, lista((f, req) => listarVendas(f, wherePagoNoPeriodo(f), req), doAfiliadoReq));

/** Comissões do afiliado, separadas por fonte (exata/Pagah/estimada/regra). */
afiliadosRouter.get('/:id/comissoes', ver, idQ, relatorio(async (f) => {
  const m = await totais(f);
  const porFonte = await prisma.venda.groupBy({
    by: ['comissaoAfiliadoFonte'],
    where: wherePagoNoPeriodo(f),
    _count: { _all: true },
    _sum: { comissaoAfiliadoCentavos: true },
  });
  return {
    comissaoAfiliadoCentavos: m.comissaoAfiliadoCentavos,
    comissaoOperacaoCentavos: m.comissaoCentavos,
    porFonteDaComissaoDoAfiliado: porFonte.map((p) => ({ fonte: p.comissaoAfiliadoFonte, pedidos: p._count._all, comissaoCentavos: p._sum.comissaoAfiliadoCentavos ?? 0 })),
  };
}, doAfiliadoReq));

afiliadosRouter.get('/:id/reembolsos', ver, idQ, lista(async (f, req) => {
  // MOVIMENTACAO: perdas reconhecidas no período; APROVADAS: pedidos pagos no período hoje perdidos
  const where = f.modo === 'MOVIMENTACAO' ? wherePerdaNoPeriodo(f) : { ...wherePagoNoPeriodo(f), perdaCentavos: { gt: 0 } };
  return listarVendas(f, where, req);
}, doAfiliadoReq));

afiliadosRouter.get('/:id/evolucao', ver, idQ, serieHandler('dia', doAfiliadoReq));

// ── aliases (somente ADMIN altera)
afiliadosRouter.get('/:id/aliases', ver, validate({ params: idUuidParams }), async (req, res) => ok(res, await listarAliases(req.valid.params.id)));

afiliadosRouter.post('/:id/aliases', admin, validate({ params: idUuidParams, body: z.object({ alias: z.string().trim().min(2).max(120) }) }), async (req, res) => {
  const r = await adicionarAlias(req.valid.params.id, req.valid.body.alias);
  await audit(req, 'afiliado.alias_criado', 'afiliado', req.valid.params.id, { alias: r.alias.alias, incorporado: r.afiliadoIncorporado, vendasMovidas: r.vendasMovidas });
  created(res, r);
});

afiliadosRouter.delete('/:id/aliases/:aliasId', admin, validate({ params: aliasParams }), async (req, res) => {
  await removerAlias(req.valid.params.id, req.valid.params.aliasId);
  await audit(req, 'afiliado.alias_removido', 'afiliado', req.valid.params.id, { aliasId: req.valid.params.aliasId });
  noContent(res);
});

// ── regras de comissão (vigência + fonte + auditoria)
export const regraBody = z
  .object({
    valorFixoCentavos: z.number().int().nonnegative().max(2_000_000_000).optional(),
    percentualBps: z.number().int().min(0).max(10000).optional(),
    vigenteDe: z.string().datetime({ offset: true }),
    vigenteAte: z.string().datetime({ offset: true }).optional(),
    fonte: z.string().trim().min(3).max(200),
    observacao: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.valorFixoCentavos === undefined) === (v.percentualBps === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'informe exatamente um: valorFixoCentavos ou percentualBps', path: ['valorFixoCentavos'] });
    }
    if (v.vigenteAte && v.vigenteAte <= v.vigenteDe) ctx.addIssue({ code: 'custom', message: 'vigenteAte deve ser posterior a vigenteDe', path: ['vigenteAte'] });
  });

afiliadosRouter.get('/:id/regras-comissao', financeiro, validate({ params: idUuidParams }), async (req, res) => ok(res, await listarRegrasComissao(req.valid.params.id)));

afiliadosRouter.post('/:id/regras-comissao', admin, validate({ params: idUuidParams, body: regraBody }), async (req, res) => {
  const r = await criarRegraComissao(req.valid.params.id, req.user!.id, req.valid.body);
  await audit(req, 'afiliado.regra_comissao_criada', 'afiliado', req.valid.params.id, { regraId: r.regra.id, fonte: r.regra.fonte, vendasRecalculadas: r.vendasRecalculadas });
  created(res, r);
});
