import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, ok } from '../../shared/utils/response';
import { construirAlertas, relatorio } from '../../shared/services/relatorio.service';
import { GRUPOS, filtrosSchema, idUuidParams } from '../../shared/validators/filtros';
import { comparativoFinanceiro, evolucaoFinanceira, resultadoFinanceiro } from './financeiro.service';

export const financeiroRouter = Router();
financeiroRouter.use(authenticate(), authorize(Roles.FINANCEIRO));

const q = validate({ query: filtrosSchema });

financeiroRouter.get('/dre', q, relatorio(async (f) => {
  const r = await resultadoFinanceiro(f);
  const m = r.metricas;
  return {
    linhas: [
      { codigo: 'RECEITA_BRUTA', descricao: 'Faturamento bruto pago (valor sem juros)', valorCentavos: r.receitaBrutaCentavos },
      { codigo: 'ESTORNOS', descricao: 'Estornos', valorCentavos: -m.estornosCentavos },
      { codigo: 'CHARGEBACKS', descricao: 'Chargebacks', valorCentavos: -m.chargebacksCentavos },
      { codigo: 'RECEITA_LIQUIDA', descricao: 'Receita líquida (critério financeiro escolhido)', valorCentavos: r.receitaLiquidaCentavos },
      { codigo: 'CUSTOS_LANCADOS', descricao: 'Custos operacionais lançados', valorCentavos: -r.custos.lancamentosCentavos },
      { codigo: 'CUSTOS_REGRAS', descricao: 'Custos por regras configuradas', valorCentavos: -r.custos.regrasCentavos },
      { codigo: 'RESULTADO_OPERACIONAL', descricao: 'Resultado operacional', valorCentavos: r.resultadoOperacionalCentavos },
    ],
    informativos: {
      comissaoCentavos: r.comissaoCentavos,
      taxaCallCenterCentavos: r.taxaCallCenterCentavos,
      observacao: 'Comissões e taxa de Call Center NÃO são deduzidas automaticamente; inclua-as via regra de custo se forem custo da operação.',
    },
    margemOperacionalPercentual: r.margemOperacionalPercentual,
    custos: { metodologia: r.custos.metodologia, regrasIndisponiveis: r.custos.regras.indisponiveis },
    alertas: await construirAlertas(f, m),
  };
}));

financeiroRouter.get('/margem', q, relatorio(async (f) => {
  const r = await resultadoFinanceiro(f);
  return { margemOperacionalPercentual: r.margemOperacionalPercentual, porGrupo: r.porGrupo.map((g) => ({ grupo: g.grupo, margemPercentual: g.margemPercentual })) };
}));

financeiroRouter.get('/resultado', q, relatorio(async (f) => {
  const { custos, metricas, ...resto } = await resultadoFinanceiro(f);
  return { ...resto, custosTotalCentavos: custos.totalCentavos };
}));

financeiroRouter.get('/custos-por-categoria', q, relatorio(async (f) => (await resultadoFinanceiro(f)).custos.porCategoria));
financeiroRouter.get('/custos-por-grupo', q, relatorio(async (f) => {
  const r = await resultadoFinanceiro(f);
  return { porGrupo: r.custos.porGrupo, naoAlocadosCentavos: r.custosNaoAlocadosCentavos };
}));
financeiroRouter.get('/evolucao', q, relatorio((f) => evolucaoFinanceira(f)));
financeiroRouter.get('/comparativo', q, relatorio((f) => comparativoFinanceiro(f)));

// ── regras de custo
const regraBase = z.object({
  nome: z.string().trim().min(2).max(120),
  tipo: z.enum(['PERCENTUAL_RECEITA', 'VALOR_POR_PEDIDO', 'VALOR_POR_UNIDADE', 'VALOR_FIXO_PERIODO']),
  grupo: z.enum(GRUPOS).nullable().optional(),
  categoriaId: z.string().uuid().nullable().optional(),
  valorCentavos: z.number().int().nonnegative().max(2_000_000_000).nullable().optional(),
  percentualBps: z.number().int().min(0).max(10000).nullable().optional(),
  vigenteDe: z.string().datetime({ offset: true }),
  vigenteAte: z.string().datetime({ offset: true }).nullable().optional(),
  metodologia: z.string().trim().min(5).max(500),
  ativa: z.boolean().default(true),
});

function validarTipo(v: { tipo?: string; valorCentavos?: number | null; percentualBps?: number | null }): string | null {
  if (v.tipo === 'PERCENTUAL_RECEITA' && (v.percentualBps === null || v.percentualBps === undefined)) return 'percentualBps é obrigatório para PERCENTUAL_RECEITA';
  if (v.tipo && v.tipo !== 'PERCENTUAL_RECEITA' && (v.valorCentavos === null || v.valorCentavos === undefined)) return 'valorCentavos é obrigatório para este tipo';
  return null;
}

export const criarRegraBody = regraBase.superRefine((v, ctx) => {
  const e = validarTipo(v);
  if (e) ctx.addIssue({ code: 'custom', message: e, path: ['tipo'] });
  if (v.vigenteAte && v.vigenteAte <= v.vigenteDe) ctx.addIssue({ code: 'custom', message: 'vigenteAte deve ser posterior a vigenteDe', path: ['vigenteAte'] });
});
export const atualizarRegraBody = regraBase.partial().refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

const toData = (b: Record<string, unknown>) => ({
  ...b,
  ...(typeof b.vigenteDe === 'string' ? { vigenteDe: new Date(b.vigenteDe) } : {}),
  ...(typeof b.vigenteAte === 'string' ? { vigenteAte: new Date(b.vigenteAte) } : {}),
});

financeiroRouter.get('/regras-custo', async (_req, res) => {
  ok(res, await prisma.regraCusto.findMany({ orderBy: [{ ativa: 'desc' }, { vigenteDe: 'desc' }] }));
});

financeiroRouter.post('/regras-custo', validate({ body: criarRegraBody }), async (req, res) => {
  const r = await prisma.regraCusto.create({ data: toData(req.valid.body) as never });
  await audit(req, 'regra_custo.criada', 'regra_custo', r.id, req.valid.body);
  created(res, r);
});

financeiroRouter.patch('/regras-custo/:id', validate({ params: idUuidParams, body: atualizarRegraBody }), async (req, res) => {
  const atual = await prisma.regraCusto.findUnique({ where: { id: req.valid.params.id } });
  if (!atual) throw Errors.notFound('Regra não encontrada');
  const e = validarTipo({ ...atual, ...req.valid.body });
  if (e) throw Errors.validation([{ path: 'tipo', message: e }]);
  const r = await prisma.regraCusto.update({ where: { id: atual.id }, data: toData(req.valid.body) as never });
  await audit(req, 'regra_custo.atualizada', 'regra_custo', r.id, req.valid.body);
  ok(res, r);
});
