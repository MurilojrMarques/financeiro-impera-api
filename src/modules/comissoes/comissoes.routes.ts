import { Router } from 'express';
import { comissaoCopyNoPeriodo } from '../../integrations/copy-supabase/copy-comissao';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { totais } from '../../shared/repositories/ledger.repository';
import { audit } from '../../shared/services/audit.service';
import { metaFinanceira } from '../../shared/services/relatorio.service';
import { ok } from '../../shared/utils/response';
import { filtrosBase, filtrosSchema, resolverFiltro } from '../../shared/validators/filtros';

export const comissoesRouter = Router();
comissoesRouter.use(authenticate(), authorize(Roles.ANALISE));

/**
 * Todas as comissões do período num lugar só, cada uma com a regra que a gera:
 *  - Front: a do sistema de copy (5% do MC BR de cada pessoa), lida de lá; a lista por pessoa é dinheiro de pessoas e só vai para FINANCEIRO+.
 *  - Call Center: 20% do líquido (valor sem juros − estornos); Recuperação: (líquido × 0,70) × 5%.
 *  - Afiliados: o que os afiliados recebem (regra por afiliado). Backend Outros: regra ainda não definida (nunca um número inventado).
 * MC BR é margem da empresa e não entra aqui.
 */
comissoesRouter.get('/resumo', validate({ query: filtrosSchema }), async (req, res) => {
  const f = resolverFiltro(req.valid.query);
  // só o período vale: loja/grupo etc. não se aplicam às regras de comissão
  const periodo = { de: req.valid.query.de, ate: req.valid.query.ate, modo: req.valid.query.modo };
  const doGrupo = (grupo: 'CALL_CENTER' | 'RECUPERACAO') => totais(resolverFiltro(filtrosBase.parse({ ...periodo, grupo })));
  const [todos, cc, rec, copy] = await Promise.all([totais(resolverFiltro(filtrosBase.parse(periodo))), doGrupo('CALL_CENTER'), doGrupo('RECUPERACAO'), comissaoCopyNoPeriodo(f.de, f.ate)]);

  const veDetalhe = req.user!.perfil === 'ADMIN' || req.user!.perfil === 'FINANCEIRO';
  if (copy.disponivel && veDetalhe) await audit(req, 'COMISSAO_COPY_CONSULTADA', 'comissao-copy', `${f.de}..${f.ate}`, {});

  const front = copy.disponivel
    ? {
        disponivel: true as const,
        estado: copy.estado,
        comissaoCentavos: copy.comissaoCentavos,
        aPagarCentavos: copy.aPagarCentavos,
        mcBrComissionavelCentavos: copy.mcBrComissionavelCentavos,
        mcBrSemComissaoCentavos: copy.mcBrSemComissaoCentavos,
        pessoas: veDetalhe ? copy.pessoas : null,
        quantidadePessoas: copy.pessoas.length,
      }
    : { disponivel: false as const, motivo: copy.motivo, mensagem: copy.mensagem };

  const comissaoFront = copy.disponivel ? copy.comissaoCentavos : 0;
  ok(
    res,
    {
      front,
      callCenter: { regra: '20% do líquido (valor sem juros − estornos e chargebacks)', baseCentavos: cc.receitaCentavos, comissaoCentavos: cc.comissaoCentavos },
      recuperacao: { regra: '(líquido × 0,70) × 5%', baseCentavos: rec.receitaCentavos, comissaoCentavos: rec.comissaoCentavos },
      afiliados: { regra: 'o que os afiliados recebem (regra por afiliado)', comissaoCentavos: todos.comissaoAfiliadoCentavos },
      backendOutros: { emImplementacao: true as const, mensagem: 'A regra da comissão do Backend Outros ainda não foi definida.' },
      totalCentavos: comissaoFront + cc.comissaoCentavos + rec.comissaoCentavos + todos.comissaoAfiliadoCentavos,
      /** true = a comissão do Front não entrou no total (sistema de copy indisponível ou período não apurável) */
      totalSemFront: !copy.disponivel,
    },
    await metaFinanceira(f),
  );
});
