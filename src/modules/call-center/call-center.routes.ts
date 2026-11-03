import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { recuperacoesCallCenter, totais } from '../../shared/repositories/ledger.repository';
import { wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import {
  comparativoHandler, construirAlertas, dimensaoHandler, forcarGrupo, formatar, lista, relatorio, serieHandler,
} from '../../shared/services/relatorio.service';
import { filtrosSchema } from '../../shared/validators/filtros';
import { resultadoFinanceiro } from '../financeiro/financeiro.service';
import { montarResumoCallCenter } from '../trafego/trafego.domain';
import { agregarGrupoParaFrete, carregarParametros } from '../trafego/trafego.routes';
import { prisma } from '../../config/database';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, ok } from '../../shared/utils/response';
import { origemEhCallCenter } from '../classificacoes/classificacao.service';
import { listarVendas } from '../vendas/vendas.service';
import { fechamentoCallCenter } from './fechamento.service';

export const callCenterRouter = Router();
callCenterRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });
const cc = forcarGrupo('CALL_CENTER');

/** Custos atribuídos ao grupo CALL_CENTER (lançamentos com grupo + regras do grupo). Custos gerais não são rateados. */
async function custosCallCenter(f: Parameters<typeof resultadoFinanceiro>[0]) {
  const r = await resultadoFinanceiro(f);
  const g = r.porGrupo.find((x) => x.grupo === 'CALL_CENTER');
  return { r, custosCentavos: g?.custosCentavos ?? 0, resultadoCentavos: g?.resultadoCentavos ?? 0, margemPercentual: g?.margemPercentual ?? null };
}

const verCustos = authorize(Roles.FINANCEIRO); // custos/margem são dados financeiros restritos

callCenterRouter.get('/resumo', q, relatorio(async (f, req) => {
  const m = await totais(f);
  const base = {
    ...formatar(m, f.modo),
    unidades: { disponivel: false, motivo: 'unidades vendidas não existem na planilha' },
    alertas: await construirAlertas(f, m),
  };
  if (!(Roles.FINANCEIRO as readonly string[]).includes(req.user!.perfil)) {
    return { ...base, custos: { restrito: true, motivo: 'custos e margem exigem perfil FINANCEIRO ou ADMIN' } };
  }
  const c = await custosCallCenter(f);
  const temCustos = c.custosCentavos > 0;
  return {
    ...base,
    sobraOperacionalEstimadaCentavos: temCustos ? c.resultadoCentavos : null,
    margemPercentual: temCustos ? c.margemPercentual : null,
    custosCentavos: c.custosCentavos,
    custosPorCategoria: c.r.custos.porCategoria,
    metodologiaCustos: c.r.custos.metodologia,
    observacaoSobra: temCustos
      ? 'Sobra = receita do Call Center − custos atribuídos ao grupo CALL_CENTER (lançamentos e regras).'
      : 'Sem custos atribuídos ao Call Center: sobra e margem indisponíveis (não são presumidas).',
  };
}, cc));

callCenterRouter.get('/vendas', q, lista((f, req) => listarVendas(f, wherePagoNoPeriodo(f), req), cc));
callCenterRouter.get('/por-atendente', q, dimensaoHandler('atendente', cc));
callCenterRouter.get('/por-loja', q, dimensaoHandler('loja', cc));
callCenterRouter.get('/por-produto', q, dimensaoHandler('produto', cc));
callCenterRouter.get('/por-metodo', q, dimensaoHandler('metodo', cc));
callCenterRouter.get('/por-tipo-atendimento', q, dimensaoHandler('tipo_atendimento', cc));

callCenterRouter.get('/recuperacoes', q, relatorio(async (f) => (await recuperacoesCallCenter(f)).map(({ chave, ...m }) => ({ categoria: chave, ...formatar(m, f.modo) })), cc));

callCenterRouter.get('/comissoes', q, relatorio(async (f) => {
  const m = await totais(f);
  return {
    comissaoCentavos: m.comissaoCentavos,
    comissaoEstimadaCentavos: m.comissaoEstimadaCentavos,
    taxaCallCenterCentavos: m.taxaCallCenterCentavos,
    pedidosSemComissao: m.pedidosSemComissao,
    observacao: 'Comissão do Call Center = 20% de tudo que ele vende. A taxa do Call Center (da planilha) é outro campo e não é somada.',
  };
}, cc));

callCenterRouter.get('/custos', verCustos, q, relatorio(async (f) => {
  const c = await custosCallCenter(f);
  return {
    totalCentavos: c.custosCentavos,
    porCategoria: c.r.custos.porCategoria,
    regrasIndisponiveis: c.r.custos.regras.indisponiveis,
    metodologia: c.r.custos.metodologia,
  };
}, cc));

callCenterRouter.get('/margem', verCustos, q, relatorio(async (f) => {
  const c = await custosCallCenter(f);
  return { receitaCentavos: c.r.metricas.receitaCentavos, custosCentavos: c.custosCentavos, resultadoCentavos: c.resultadoCentavos, margemPercentual: c.margemPercentual };
}, cc));

/**
 * O fechamento do mês na fórmula da planilha do dono: vendas de origem Call/Whats pagas no mês e ainda pagas, 20% de comissão,
 * menos os chargebacks de pedidos pagos antes do mês. Dinheiro da operação: só FINANCEIRO/ADMIN. Independe do grupo da
 * classificação (a origem do Pagah manda) e diz quantos pedidos ficaram de fora por falta de origem.
 */
const fechamentoQuery = z
  .object({
    mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use AAAA-MM').optional(),
    de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD').optional(),
    ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD').optional(),
    /** "como estava" no começo deste dia (AAAA-MM-DD); padrão: o fim do período. Serve para reproduzir um arquivo exportado depois. */
    posicao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD').optional(),
  })
  .refine((q) => (q.mes !== undefined) !== (q.de !== undefined && q.ate !== undefined), 'informe `mes` OU `de` e `ate`');
callCenterRouter.get('/fechamento', verCustos, validate({ query: fechamentoQuery }), async (req, res) => {
  const q = req.valid.query as { mes?: string; de?: string; ate?: string; posicao?: string };
  ok(res, await fechamentoCallCenter(q.mes ?? { de: q.de!, ate: q.ate! }, q.posicao ? new Date(`${q.posicao}T00:00:00-03:00`) : undefined));
});

/**
 * Ajustes manuais do fechamento: quando o dado do Pagah e o arquivo do dono discordam sobre um pedido e as duas pontas foram
 * conferidas, o financeiro decide em que competência ele conta. O ajuste nunca muda a venda, só o fechamento daquele mês, e
 * aparece na tela e na resposta com o motivo (o fechamento não esconde que houve ajuste). Só FINANCEIRO/ADMIN.
 */
const competenciaRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const ajusteBody = z.object({
  competencia: z.string().regex(competenciaRe, 'use AAAA-MM'),
  pedido: z.string().regex(/^\d{3,12}$/, 'número do pedido'),
  acao: z.enum(['INCLUIR_VENDA', 'EXCLUIR_VENDA']),
  motivo: z.string().trim().min(15, 'conte o motivo em pelo menos 15 caracteres').max(600),
});
callCenterRouter.get('/fechamento/ajustes', verCustos, validate({ query: z.object({ competencia: z.string().regex(competenciaRe) }) }), async (req, res) => {
  const { competencia } = req.valid.query as { competencia: string };
  ok(res, await prisma.fechamentoAjuste.findMany({ where: { competencia }, orderBy: { criadoEm: 'asc' } }));
});
callCenterRouter.post('/fechamento/ajustes', verCustos, validate({ body: ajusteBody }), async (req, res) => {
  const b = req.valid.body as z.infer<typeof ajusteBody>;
  const venda = await prisma.venda.findUnique({ where: { pedido: b.pedido }, select: { origem: true } });
  if (!venda) throw Errors.notFound('Pedido não encontrado na base');
  if (!origemEhCallCenter(venda.origem)) throw Errors.conflict('O ajuste vale para pedido de origem Call ou Whats; este não tem essa origem.', 'AJUSTE_SEM_EFEITO');
  const existente = await prisma.fechamentoAjuste.findUnique({ where: { competencia_pedido: { competencia: b.competencia, pedido: b.pedido } } });
  if (existente) throw Errors.conflict('Este pedido já tem um ajuste nesta competência. Remova o anterior para trocar.', 'AJUSTE_JA_EXISTE');
  const novo = await prisma.fechamentoAjuste.create({ data: { ...b, criadoPorId: req.user!.id } });
  await audit(req, 'call_center.fechamento_ajuste_criado', 'fechamento_ajuste', novo.id, { competencia: b.competencia, pedido: b.pedido, acao: b.acao });
  created(res, novo);
});
callCenterRouter.delete('/fechamento/ajustes/:id', verCustos, validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  const { id } = req.valid.params as { id: string };
  const ajuste = await prisma.fechamentoAjuste.findUnique({ where: { id } });
  if (!ajuste) throw Errors.notFound('Ajuste não encontrado');
  await prisma.fechamentoAjuste.delete({ where: { id } });
  await audit(req, 'call_center.fechamento_ajuste_removido', 'fechamento_ajuste', id, { competencia: ajuste.competencia, pedido: ajuste.pedido, acao: ajuste.acao });
  ok(res, { removido: true });
});

callCenterRouter.get('/evolucao', q, serieHandler('dia', cc));
callCenterRouter.get('/comparativo', q, comparativoHandler(cc));

/** Receita do Call Center → custos (taxas, frete por remessa, produto) → sobra. Custos da operação só para FINANCEIRO/ADMIN. */
callCenterRouter.get('/receita-custos', q, relatorio(async (f, req) => {
  const [m, params, agg] = await Promise.all([totais(f), carregarParametros(), agregarGrupoParaFrete('CALL_CENTER', f.deTs, f.ateTsExcl)]);
  const podeVerCustos = (Roles.FINANCEIRO as readonly string[]).includes(req.user!.perfil);
  const operacao = podeVerCustos ? (await custosCallCenter(f)).custosCentavos : null;
  const resumo = montarResumoCallCenter({ faturamentoCentavos: m.brutoCentavos, receitaLiquidaCentavos: m.receitaCentavos, pedidos: m.pedidos, remessas: agg.remessas, kits: agg.kits, custosOperacaoCentavos: operacao }, params);
  const avisos: string[] = [];
  if (!podeVerCustos) avisos.push('Custos da operação, sobra e margem exigem perfil FINANCEIRO ou ADMIN.');
  if (resumo.kitsSemQuantidade > 0) avisos.push(`${resumo.kitsSemQuantidade} itens sem quantidade no nome do kit: contados como 1 unidade.`);
  return { ...resumo, avisos };
}, cc));
