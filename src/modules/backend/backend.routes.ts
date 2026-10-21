import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { porCanal, totais, type Metricas } from '../../shared/repositories/ledger.repository';
import { wherePagoNoPeriodo } from '../../shared/repositories/vendas.where';
import {
  comparativoHandler, dimensaoHandler, forcarGrupo, formatar, lista, relatorio, resumoHandler, serieHandler,
} from '../../shared/services/relatorio.service';
import { filtrosSchema } from '../../shared/validators/filtros';
import { listarVendas } from '../vendas/vendas.service';

export const backendRouter = Router();
backendRouter.use(authenticate(), authorize(Roles.ANALISE));

const q = validate({ query: filtrosSchema });
/** /backend = BACKEND_OUTROS: SMS, e-mail marketing e disparo (NÃO inclui Call Center nem Recuperação de vendas). */
const outros = forcarGrupo('BACKEND_OUTROS');

const somar = (a: Metricas, b: Metricas): Metricas => {
  const r = { ...a };
  (Object.keys(r) as (keyof Metricas)[]).forEach((k) => (r[k] = a[k] + b[k]));
  return r;
};

backendRouter.get('/resumo', q, resumoHandler(outros));

/** Visão consolidada: backendTotal = backendOutros + callCenter + recuperação. Indicador agregado; nunca somar de novo. */
backendRouter.get('/total', q, relatorio(async (f) => {
  const [o, c, r] = await Promise.all([totais({ ...f, grupo: 'BACKEND_OUTROS' }), totais({ ...f, grupo: 'CALL_CENTER' }), totais({ ...f, grupo: 'RECUPERACAO' })]);
  return {
    backendOutros: formatar(o, f.modo),
    callCenter: formatar(c, f.modo),
    recuperacao: formatar(r, f.modo),
    backendTotal: formatar(somar(somar(o, c), r), f.modo),
    composicao: 'backendTotal = backendOutros + callCenter + recuperacao. É um indicador agregado: NÃO some backendTotal aos grupos (dupla contagem).',
  };
}));

backendRouter.get('/vendas', q, lista((f, req) => listarVendas(f, wherePagoNoPeriodo(f), req), outros));
backendRouter.get('/por-canal', q, relatorio(async (f) => (await porCanal(f)).map(({ chave, ...m }) => ({ canal: chave ?? '(regra sem canal)', ...formatar(m, f.modo) })), outros));
backendRouter.get('/por-origem', q, dimensaoHandler('origem', outros));
backendRouter.get('/por-loja', q, dimensaoHandler('loja', outros));
backendRouter.get('/por-produto', q, dimensaoHandler('produto', outros));
backendRouter.get('/evolucao', q, serieHandler('dia', outros));
backendRouter.get('/comparativo', q, comparativoHandler(outros));

/** Relatório de pendências: vendas que nenhuma regra/critério conseguiu classificar. */
backendRouter.get(
  '/nao-classificadas',
  q,
  lista((f, req) => listarVendas(f, wherePagoNoPeriodo(f), req), (f) => ({ ...f, grupo: 'NAO_CLASSIFICADA' })),
);
