import { Router } from 'express';
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
import { listarVendas } from '../vendas/vendas.service';

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
    observacao: 'Comissão da operação e taxa do Call Center são campos distintos e não são somados.',
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
