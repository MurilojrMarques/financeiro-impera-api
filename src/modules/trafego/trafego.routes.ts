import { Router } from 'express';
import { prisma } from '../../config/database';
import { Prisma } from '../../generated/prisma/client';
import { investimentoNoPeriodo } from '../../integrations/redtrack/redtrack.client';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { audit } from '../../shared/services/audit.service';
import { metaFinanceira } from '../../shared/services/relatorio.service';
import { ok } from '../../shared/utils/response';
import { filtrosSchema, resolverFiltro } from '../../shared/validators/filtros';
import { PARAMETROS_PADRAO, montarResumo, parametrosSchema, type KitAgregado, type Parametros } from './trafego.domain';

export const trafegoRouter = Router();
trafegoRouter.use(authenticate(), authorize(Roles.ANALISE));

const CHAVE = 'trafego.parametros';

export async function carregarParametros(): Promise<Parametros> {
  const row = await prisma.configuracaoFinanceira.findUnique({ where: { chave: CHAVE } });
  const parsed = parametrosSchema.safeParse(row?.valor);
  return parsed.success ? parsed.data : PARAMETROS_PADRAO;
}

/** Instante ISO com cast explícito: independe do fuso da sessão do banco (ver ledger.repository). */
const tsz = (d: Date) => Prisma.sql`${d.toISOString()}::timestamptz`;

/** Faturamento do tráfego (conferência com a planilha) = pagamentos do período (valor sem juros) das vendas do site, sem descontar estornos. */
async function agregarFront(deTs: Date, ateTsExcl: Date, deslocMin: number) {
  // Vendas do SITE (base do RedTrack): tudo com tipo compra/upsell/downsell pago no checkout do site, qualquer que seja o canal que
  // fechou (front, recuperação por link do vendedor, SMS/e-mail de back end). Call center e afiliado ficam de fora.
  const janela = Prisma.sql`v."tipoVenda" IN ('FRONT', 'UPSELL', 'DOWNSELL') AND v."grupo" <> 'AFILIADO' AND v."pagoEm" >= ${tsz(deTs)} AND v."pagoEm" < ${tsz(ateTsExcl)}`;
  const [kits, tot, remessas] = await Promise.all([
    prisma.$queryRaw<{ kit: string | null; pedidos: bigint }[]>(Prisma.sql`SELECT v."kitNome" AS kit, COUNT(*)::bigint AS pedidos FROM vendas v WHERE ${janela} GROUP BY 1`),
    prisma.$queryRaw<{ faturamento: bigint | null; compras: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(v."valorVendaCentavos"), 0)::bigint AS faturamento, COUNT(*) FILTER (WHERE v."tipoVenda" = 'FRONT')::bigint AS compras
      FROM vendas v WHERE ${janela}`),
    // uma remessa por cliente por dia (SP) entre as COMPRAS; compra sem cliente conhecido conta como remessa própria
    prisma.$queryRaw<{ com_cliente: bigint; sem_cliente: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT (v."clienteHash", ((v."pagoEm" + ${deslocMin} * interval '1 minute') AT TIME ZONE 'America/Sao_Paulo')::date)) FILTER (WHERE v."clienteHash" IS NOT NULL)::bigint AS com_cliente,
             COUNT(*) FILTER (WHERE v."clienteHash" IS NULL)::bigint AS sem_cliente
      FROM vendas v WHERE ${janela} AND v."tipoVenda" = 'FRONT'`),
  ]);
  const kitsAgg: KitAgregado[] = kits.map((k) => ({ kit: k.kit, pedidos: Number(k.pedidos) }));
  return {
    faturamentoCentavos: Number(tot[0]?.faturamento ?? 0),
    pedidos: Number(tot[0]?.compras ?? 0),
    fretes: Number(remessas[0]?.com_cliente ?? 0) + Number(remessas[0]?.sem_cliente ?? 0),
    comprasSemCliente: Number(remessas[0]?.sem_cliente ?? 0),
    kits: kitsAgg,
  };
}

/** Remessas (cliente + dia de SP) e kits de um grupo no período, para frete e custo de produto. */
export async function agregarGrupoParaFrete(grupo: 'CALL_CENTER' | 'FRONT' | 'AFILIADO' | 'BACKEND_OUTROS', deTs: Date, ateTsExcl: Date) {
  const janela = Prisma.sql`v."grupo" = ${grupo}::"TipoGrupo" AND v."pagoEm" >= ${tsz(deTs)} AND v."pagoEm" < ${tsz(ateTsExcl)}`;
  const [kits, remessas] = await Promise.all([
    prisma.$queryRaw<{ kit: string | null; pedidos: bigint }[]>(Prisma.sql`SELECT v."kitNome" AS kit, COUNT(*)::bigint AS pedidos FROM vendas v WHERE ${janela} GROUP BY 1`),
    prisma.$queryRaw<{ com_cliente: bigint; sem_cliente: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT (v."clienteHash", (v."pagoEm" AT TIME ZONE 'America/Sao_Paulo')::date)) FILTER (WHERE v."clienteHash" IS NOT NULL)::bigint AS com_cliente,
             COUNT(*) FILTER (WHERE v."clienteHash" IS NULL)::bigint AS sem_cliente
      FROM vendas v WHERE ${janela}`),
  ]);
  return {
    remessas: Number(remessas[0]?.com_cliente ?? 0) + Number(remessas[0]?.sem_cliente ?? 0),
    kits: kits.map((k) => ({ kit: k.kit, pedidos: Number(k.pedidos) })) as KitAgregado[],
  };
}

trafegoRouter.get('/resumo', validate({ query: filtrosSchema }), async (req, res) => {
  const f = resolverFiltro(req.valid.query);
  const params = await carregarParametros();
  // janela do dia do tráfego, alinhada ao RedTrack (ver janelaDeslocamentoMin); o investimento é pedido por data ao RedTrack
  const ini = new Date(f.deTs.getTime() + params.janelaDeslocamentoMin * 60_000);
  const fim = new Date(f.ateTsExcl.getTime() + params.janelaDeslocamentoMin * 60_000);
  const [agg, inv] = await Promise.all([agregarFront(ini, fim, -params.janelaDeslocamentoMin), investimentoNoPeriodo(f.de, f.ate)]);
  // Base da DRE (Copy/Pulso): faturamento e pedidos do RedTrack quando disponível; a planilha Pagah é a conferência (e o fallback)
  const usaRt = inv.fonte === 'REDTRACK' && inv.faturamentoCentavos != null && inv.compras != null;
  const rt = usaRt ? { faturamentoCentavos: inv.faturamentoCentavos as number, pedidos: inv.compras as number } : null;
  const planilha = { faturamentoCentavos: agg.faturamentoCentavos, pedidos: agg.pedidos };
  // O frete só existe para os pedidos que contam no faturamento (os atribuídos pelo RedTrack): aplica-se a taxa de consolidação
  // observada na planilha (remessas ÷ compras) ao número de pedidos do RedTrack.
  const fretes = rt && planilha.pedidos > 0 ? Math.round((rt.pedidos * agg.fretes) / planilha.pedidos) : agg.fretes;
  const resumo = montarResumo(
    { faturamentoCentavos: rt ? rt.faturamentoCentavos : planilha.faturamentoCentavos, pedidos: rt ? rt.pedidos : planilha.pedidos, fretes, kits: agg.kits, investimentoCentavos: inv.centavos },
    params,
  );
  const conferencia = {
    fonteBase: rt ? 'REDTRACK' : 'PLANILHA',
    redtrack: rt,
    downsellsRedtrackCentavos: rt ? (inv.downsellsCentavos ?? 0) : null,
    planilha,
    diferencaFaturamentoCentavos: rt ? planilha.faturamentoCentavos - rt.faturamentoCentavos : null,
    diferencaFaturamentoBp: rt && rt.faturamentoCentavos !== 0 ? Math.round(((planilha.faturamentoCentavos - rt.faturamentoCentavos) * 10000) / rt.faturamentoCentavos) : null,
    diferencaPedidos: rt ? planilha.pedidos - rt.pedidos : null,
  };

  const avisos: string[] = [];
  if (inv.centavos === null && inv.mensagem) avisos.push(`Investimento indisponível: ${inv.mensagem} ROAS, CPA, sobra e margem não são calculados.`);
  if (agg.comprasSemCliente > 0) avisos.push(`${agg.comprasSemCliente} compras sem identificação do cliente: cada uma foi contada como uma remessa.`);
  if (resumo.kitsSemQuantidade > 0) avisos.push(`${resumo.kitsSemQuantidade} itens sem quantidade no nome do kit: contados como 1 unidade.`);

  if (rt) avisos.push('Faturamento, pedidos e investimento vêm do RedTrack (base da DRE); frete e custo de produto usam a planilha Pagah.');

  ok(res, { ...resumo, conferencia, avisos }, await metaFinanceira(f, { fonteInvestimento: inv.fonte, janelaTrafego: { inicio: ini.toISOString(), fim: fim.toISOString(), deslocamentoMin: params.janelaDeslocamentoMin } }));
});

trafegoRouter.get('/parametros', async (_req, res) => {
  ok(res, { parametros: await carregarParametros(), padrao: PARAMETROS_PADRAO });
});

trafegoRouter.put('/parametros', authorize(Roles.FINANCEIRO), validate({ body: parametrosSchema }), async (req, res) => {
  const antes = await carregarParametros();
  const valor = req.valid.body as Parametros;
  await prisma.configuracaoFinanceira.upsert({ where: { chave: CHAVE }, create: { chave: CHAVE, valor }, update: { valor } });
  await audit(req, 'TRAFEGO_PARAMETROS_ATUALIZADOS', 'configuracao', CHAVE, { antes, depois: valor });
  ok(res, { parametros: valor });
});
