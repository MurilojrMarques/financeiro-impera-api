import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../config/database';
import { BUSINESS_TZ } from '../utils/dates';
import type { FiltroResolvido } from '../validators/filtros';

/**
 * LEDGER — fonte única de métricas financeiras.
 *
 * Cada venda gera até 2 linhas:
 *   • linha de PAGAMENTO, datada em pagoEm;
 *   • linha de PERDA (somente critério MOVIMENTACAO), datada em perdaEm.
 * Grupos de receita são mutuamente exclusivos (coluna `grupo` da venda): nenhuma venda pertence a dois grupos,
 * logo somar grupos nunca duplica receita. `backendTotal` = BACKEND_OUTROS + CALL_CENTER é derivado, nunca somado de novo.
 *
 *   APROVADAS    (aproxima o painel Pagah): pedidos pagos no período, pelo STATUS ATUAL.
 *                receita = valor_sem_juros − perda atual; pedido integralmente perdido não conta.
 *   MOVIMENTACAO: pagamentos do período − perdas reconhecidas na DATA do evento de perda.
 *
 * Comissão X1 entra como 0 (regra padrão); o valor real fica em `x1ComissaoRealCentavos`, informativo.
 * Valores em centavos inteiros (SUM em bigint); nenhuma conta com float.
 */

export interface Metricas {
  pedidos: number;
  brutoCentavos: number;
  receitaCentavos: number;
  comissaoCentavos: number;
  /** comissão do AFILIADO (distinta da comissão da operação) */
  comissaoAfiliadoCentavos: number;
  /** parcela da comissão do afiliado vinda de REGRA configurada (estimada), não de valor exato da fonte */
  comissaoAfiliadoEstimadaCentavos: number;
  comissaoEstimadaCentavos: number;
  x1ComissaoRealCentavos: number;
  pedidosSemComissao: number;
  taxaCallCenterCentavos: number;
  estornosCentavos: number;
  estornosQtd: number;
  chargebacksCentavos: number;
  chargebacksQtd: number;
}

export type Dimensao =
  | 'grupo' | 'loja' | 'produto' | 'metodo' | 'status' | 'origem' | 'afiliado'
  | 'campanha' | 'anuncio' | 'tipo_atendimento' | 'atendente' | 'tipo_venda';

const DIM_SQL: Record<Dimensao, string> = {
  grupo: 'm.grupo',
  loja: 'm.loja',
  produto: 'm.produto',
  metodo: 'm.metodo',
  status: 'm.status',
  origem: 'm.origem',
  afiliado: 'm.afiliado',
  campanha: 'm.campanha',
  anuncio: 'm.anuncio',
  tipo_atendimento: 'm.tipo_atendimento',
  atendente: 'm.atendente',
  tipo_venda: 'm.tipo_venda',
};

export type Bucket = 'dia' | 'hora' | 'semana' | 'mes';
const BUCKET_SQL: Record<Bucket, string> = {
  dia: `to_char(m.ref AT TIME ZONE '${BUSINESS_TZ}', 'YYYY-MM-DD')`,
  hora: `to_char(m.ref AT TIME ZONE '${BUSINESS_TZ}', 'HH24') || ':00'`,
  semana: `to_char(date_trunc('week', m.ref AT TIME ZONE '${BUSINESS_TZ}'), 'YYYY-MM-DD')`,
  mes: `to_char(m.ref AT TIME ZONE '${BUSINESS_TZ}', 'YYYY-MM')`,
};

/**
 * Instante como texto ISO (UTC) com cast explícito. Passar `Date` cru como parâmetro de $queryRaw chega ao Postgres como
 * `timestamp` SEM fuso e é reinterpretado no fuso da SESSÃO: com o banco em America/Sao_Paulo o intervalo deslocava +3h
 * (ex.: "ontem" virava 03:00–03:00 UTC-3), contando vendas do dia errado. O cast torna o resultado independente do fuso do banco.
 */
const tsz = (d: Date): Prisma.Sql => Prisma.sql`${d.toISOString()}::timestamptz`;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Condições de dimensão (valores sempre parametrizados). */
export function condicoesDimensao(f: FiltroResolvido): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (f.loja) c.push(Prisma.sql`l.nome = ${f.loja}`);
  if (f.produto) c.push(Prisma.sql`v."kitNome" = ${f.produto}`);
  if (f.grupo) c.push(Prisma.sql`v."grupo" = ${f.grupo}::"TipoGrupo"`);
  if (f.afiliadoId) c.push(Prisma.sql`v."afiliadoId" = ${f.afiliadoId}::uuid`);
  if (f.metodo) c.push(Prisma.sql`lower(v."metodoPagamento") = lower(${f.metodo})`);
  if (f.status) c.push(Prisma.sql`v."status" = ${f.status}::"StatusVenda"`);
  if (f.origem) c.push(Prisma.sql`v."origem" = ${f.origem}`);
  if (f.campanha) c.push(Prisma.sql`v."campanha" = ${f.campanha}`);
  if (f.anuncio) c.push(Prisma.sql`v."anuncio" = ${f.anuncio}`);
  if (f.tipo) c.push(Prisma.sql`v."tipoVenda" = ${f.tipo === 'COMPRA' ? 'FRONT' : f.tipo}::"TipoVenda"`);
  return c;
}

const COLUNAS = Prisma.raw(`
  v.id AS venda_id, v.pedido, v."grupo"::text AS grupo, v."tipoVenda"::text AS tipo_venda, v."status"::text AS status,
  l.nome AS loja, a.id::text AS afiliado_id, a.nome AS afiliado, v."kitNome" AS produto, v."metodoPagamento" AS metodo,
  v.origem AS origem, v.campanha AS campanha, v.anuncio AS anuncio, v."tipoAtendimento" AS tipo_atendimento,
  COALESCE(v.atendente, CASE WHEN v."grupo" IN ('CALL_CENTER', 'RECUPERACAO') THEN v.subcanal END) AS atendente, v.subcanal AS subcanal,
  v."classificacaoRegraId"::text AS regra_id`);

const FROM = Prisma.raw(`FROM vendas v LEFT JOIN lojas l ON l.id = v."lojaId" LEFT JOIN afiliados a ON a.id = v."afiliadoId"`);

const COMISSAO_BASE = `CASE WHEN v.x1 THEN 0 ELSE COALESCE(v."comissaoCentavos", 0) END`;
const COMISSAO_REAL_X1 = `CASE WHEN v.x1 THEN COALESCE(v."comissaoCentavos", 0) ELSE 0 END`;
const ESTIMADA = `CASE WHEN v."comissaoFonte" IN ('ESTIMADA','REGRA_AFILIADO') AND NOT v.x1 THEN COALESCE(v."comissaoCentavos", 0) ELSE 0 END`;
const SEM_COM = `CASE WHEN v."comissaoCentavos" IS NULL THEN 1 ELSE 0 END`;
const TAXA = `COALESCE(v."taxaCallCenterCentavos", 0)`;
const NAO_PERDIDO = `v."perdaCentavos" < v."valorVendaCentavos"`;

function linhaPagamento(modo: FiltroResolvido['modo']): Prisma.Sql {
  if (modo === 'APROVADAS') {
    return Prisma.raw(`
      v."pagoEm" AS ref,
      CASE WHEN ${NAO_PERDIDO} THEN 1 ELSE 0 END AS pedidos,
      v."valorVendaCentavos" AS bruto,
      v."valorVendaCentavos" - v."perdaCentavos" AS receita,
      CASE WHEN ${NAO_PERDIDO} THEN ${COMISSAO_BASE} ELSE 0 END AS comissao,
      CASE WHEN ${NAO_PERDIDO} THEN COALESCE(v.\"comissaoAfiliadoCentavos\", 0) ELSE 0 END AS comissao_afil,
      CASE WHEN ${NAO_PERDIDO} AND v.\"comissaoAfiliadoFonte\" = 'REGRA_AFILIADO' THEN COALESCE(v.\"comissaoAfiliadoCentavos\", 0) ELSE 0 END AS comissao_afil_est,
      CASE WHEN ${NAO_PERDIDO} THEN ${ESTIMADA} ELSE 0 END AS comissao_estimada,
      CASE WHEN ${NAO_PERDIDO} THEN ${COMISSAO_REAL_X1} ELSE 0 END AS x1_real,
      CASE WHEN ${NAO_PERDIDO} THEN ${SEM_COM} ELSE 0 END AS sem_comissao,
      CASE WHEN ${NAO_PERDIDO} THEN ${TAXA} ELSE 0 END AS taxa_cc,
      CASE WHEN v."perdaTipo" = 'ESTORNO' THEN v."perdaCentavos" ELSE 0 END AS estorno_cent,
      CASE WHEN v."perdaTipo" = 'ESTORNO' AND v."perdaCentavos" > 0 THEN 1 ELSE 0 END AS estorno_qtd,
      CASE WHEN v."perdaTipo" = 'CHARGEBACK' THEN v."perdaCentavos" ELSE 0 END AS charge_cent,
      CASE WHEN v."perdaTipo" = 'CHARGEBACK' AND v."perdaCentavos" > 0 THEN 1 ELSE 0 END AS charge_qtd`);
  }
  return Prisma.raw(`
    v."pagoEm" AS ref,
    1 AS pedidos,
    v."valorVendaCentavos" AS bruto,
    v."valorVendaCentavos" AS receita,
    ${COMISSAO_BASE} AS comissao,
    COALESCE(v.\"comissaoAfiliadoCentavos\", 0) AS comissao_afil,
    CASE WHEN v.\"comissaoAfiliadoFonte\" = 'REGRA_AFILIADO' THEN COALESCE(v.\"comissaoAfiliadoCentavos\", 0) ELSE 0 END AS comissao_afil_est,
    ${ESTIMADA} AS comissao_estimada,
    ${COMISSAO_REAL_X1} AS x1_real,
    ${SEM_COM} AS sem_comissao,
    ${TAXA} AS taxa_cc,
    0 AS estorno_cent, 0 AS estorno_qtd, 0 AS charge_cent, 0 AS charge_qtd`);
}

const LINHA_PERDA = Prisma.raw(`
  v."perdaEm" AS ref,
  0 AS pedidos, 0 AS bruto, -v."perdaCentavos" AS receita,
  0 AS comissao, 0 AS comissao_afil, 0 AS comissao_afil_est, 0 AS comissao_estimada, 0 AS x1_real, 0 AS sem_comissao, 0 AS taxa_cc,
  CASE WHEN v."perdaTipo" = 'ESTORNO' THEN v."perdaCentavos" ELSE 0 END AS estorno_cent,
  CASE WHEN v."perdaTipo" = 'ESTORNO' THEN 1 ELSE 0 END AS estorno_qtd,
  CASE WHEN v."perdaTipo" = 'CHARGEBACK' THEN v."perdaCentavos" ELSE 0 END AS charge_cent,
  CASE WHEN v."perdaTipo" = 'CHARGEBACK' THEN 1 ELSE 0 END AS charge_qtd`);

export function ledgerSql(f: FiltroResolvido): Prisma.Sql {
  const dims = condicoesDimensao(f);
  const wherePag = Prisma.join(
    [Prisma.sql`v."pagoEm" >= ${tsz(f.deTs)}`, Prisma.sql`v."pagoEm" < ${tsz(f.ateTsExcl)}`, ...dims],
    ' AND ',
  );
  const pagamentos = Prisma.sql`SELECT ${COLUNAS}, ${linhaPagamento(f.modo)} ${FROM} WHERE ${wherePag}`;
  if (f.modo === 'APROVADAS') return pagamentos;

  const wherePerda = Prisma.join(
    [Prisma.sql`v."perdaCentavos" > 0`, Prisma.sql`v."perdaEm" >= ${tsz(f.deTs)}`, Prisma.sql`v."perdaEm" < ${tsz(f.ateTsExcl)}`, ...dims],
    ' AND ',
  );
  return Prisma.sql`${pagamentos} UNION ALL SELECT ${COLUNAS}, ${LINHA_PERDA} ${FROM} WHERE ${wherePerda}`;
}

const SOMAS = Prisma.raw(`
  COALESCE(SUM(m.pedidos),0)::bigint AS pedidos,
  COALESCE(SUM(m.bruto),0)::bigint AS bruto,
  COALESCE(SUM(m.receita),0)::bigint AS receita,
  COALESCE(SUM(m.comissao),0)::bigint AS comissao,
  COALESCE(SUM(m.comissao_afil),0)::bigint AS comissao_afil,
  COALESCE(SUM(m.comissao_afil_est),0)::bigint AS comissao_afil_est,
  COALESCE(SUM(m.comissao_estimada),0)::bigint AS comissao_estimada,
  COALESCE(SUM(m.x1_real),0)::bigint AS x1_real,
  COALESCE(SUM(m.sem_comissao),0)::bigint AS sem_comissao,
  COALESCE(SUM(m.taxa_cc),0)::bigint AS taxa_cc,
  COALESCE(SUM(m.estorno_cent),0)::bigint AS estorno_cent,
  COALESCE(SUM(m.estorno_qtd),0)::bigint AS estorno_qtd,
  COALESCE(SUM(m.charge_cent),0)::bigint AS charge_cent,
  COALESCE(SUM(m.charge_qtd),0)::bigint AS charge_qtd`);

type RowSomas = Record<string, unknown>;

function paraMetricas(r: RowSomas): Metricas {
  return {
    pedidos: num(r.pedidos),
    brutoCentavos: num(r.bruto),
    receitaCentavos: num(r.receita),
    comissaoCentavos: num(r.comissao),
    comissaoAfiliadoCentavos: num(r.comissao_afil),
    comissaoAfiliadoEstimadaCentavos: num(r.comissao_afil_est),
    comissaoEstimadaCentavos: num(r.comissao_estimada),
    x1ComissaoRealCentavos: num(r.x1_real),
    pedidosSemComissao: num(r.sem_comissao),
    taxaCallCenterCentavos: num(r.taxa_cc),
    estornosCentavos: num(r.estorno_cent),
    estornosQtd: num(r.estorno_qtd),
    chargebacksCentavos: num(r.charge_cent),
    chargebacksQtd: num(r.charge_qtd),
  };
}

export async function totais(f: FiltroResolvido): Promise<Metricas> {
  const rows = await prisma.$queryRaw<RowSomas[]>`SELECT ${SOMAS} FROM (${ledgerSql(f)}) m`;
  return paraMetricas(rows[0] ?? {});
}

export type LinhaDimensao = Metricas & { chave: string | null; id?: string | null };

export async function porDimensao(f: FiltroResolvido, dim: Dimensao, limite = 500): Promise<LinhaDimensao[]> {
  // Afiliados agrupam pelo ID estável (nunca pelo nome), expondo o nome canônico como chave de exibição.
  const porId = dim === 'afiliado';
  const expr = Prisma.raw(porId ? 'm.afiliado_id' : DIM_SQL[dim]);
  const chaveSel = Prisma.raw(porId ? 'MIN(m.afiliado) AS chave, m.afiliado_id AS id' : `${DIM_SQL[dim]} AS chave`);
  const rows = await prisma.$queryRaw<RowSomas[]>`
    SELECT ${chaveSel}, ${SOMAS}
    FROM (${ledgerSql(f)}) m
    GROUP BY ${expr}
    ORDER BY COALESCE(SUM(m.receita),0) DESC, ${expr} ASC NULLS LAST
    LIMIT ${limite}`;
  return rows.map((r) => ({ chave: (r.chave as string | null) ?? null, id: (r.id as string | null) ?? null, ...paraMetricas(r) }));
}

/** Back-end por canal: `subcanal` da planilha (SMS, e-mail, disparo) ou rótulo `canal` da regra de classificação que casou. */
export async function porCanal(f: FiltroResolvido): Promise<LinhaDimensao[]> {
  const rows = await prisma.$queryRaw<RowSomas[]>`
    SELECT COALESCE(r.canal, CASE WHEN m.grupo = 'BACKEND_OUTROS' THEN m.subcanal END) AS chave, ${SOMAS}
    FROM (${ledgerSql(f)}) m
    LEFT JOIN regras_classificacao r ON r.id::text = m.regra_id
    GROUP BY 1
    ORDER BY COALESCE(SUM(m.receita),0) DESC`;
  return rows.map((r) => ({ chave: (r.chave as string | null) ?? null, ...paraMetricas(r) }));
}

/** Call Center: categoria de recuperação derivada do texto de tipo_atendimento (somente quando o campo existe). */
export async function recuperacoesCallCenter(f: FiltroResolvido): Promise<LinhaDimensao[]> {
  const rows = await prisma.$queryRaw<RowSomas[]>`
    SELECT CASE
        WHEN m.tipo_atendimento IS NULL THEN 'NAO_INFORMADO'
        WHEN lower(m.tipo_atendimento) LIKE '%pix%' THEN 'PIX'
        WHEN lower(m.tipo_atendimento) LIKE '%boleto%' THEN 'BOLETO'
        WHEN lower(m.tipo_atendimento) LIKE '%abandon%' THEN 'ABANDONO'
        ELSE 'OUTROS' END AS chave,
      ${SOMAS}
    FROM (${ledgerSql(f)}) m
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({ chave: String(r.chave), ...paraMetricas(r) }));
}

export async function serie(f: FiltroResolvido, bucket: Bucket): Promise<(Metricas & { periodo: string })[]> {
  const expr = Prisma.raw(BUCKET_SQL[bucket]);
  const rows = await prisma.$queryRaw<RowSomas[]>`
    SELECT ${expr} AS periodo, ${SOMAS}
    FROM (${ledgerSql(f)}) m
    GROUP BY 1 ORDER BY 1 ASC`;
  return rows.map((r) => ({ periodo: String(r.periodo), ...paraMetricas(r) }));
}

/** Contagens de qualidade de dados para alertas (independentes do critério financeiro). */
export async function alertasQualidade(f: FiltroResolvido): Promise<{
  naoClassificadas: number;
  pendentesConciliacao: number;
  comAvisos: number;
  semDataEstorno: number;
}> {
  const dims = condicoesDimensao(f);
  const where = Prisma.join([Prisma.sql`v."pagoEm" >= ${tsz(f.deTs)}`, Prisma.sql`v."pagoEm" < ${tsz(f.ateTsExcl)}`, ...dims], ' AND ');
  const rows = await prisma.$queryRaw<RowSomas[]>`
    SELECT
      COUNT(*) FILTER (WHERE v."grupo" = 'NAO_CLASSIFICADA')::bigint AS nao_class,
      COUNT(*) FILTER (WHERE v."status" = 'PENDENTE_CONCILIACAO')::bigint AS pendentes,
      COUNT(*) FILTER (WHERE cardinality(v."avisos") > 0)::bigint AS avisos,
      COUNT(*) FILTER (WHERE v."perdaCentavos" > 0 AND v."perdaEm" IS NULL)::bigint AS sem_data
    ${FROM} WHERE ${where}`;
  const r = rows[0] ?? {};
  return { naoClassificadas: num(r.nao_class), pendentesConciliacao: num(r.pendentes), comAvisos: num(r.avisos), semDataEstorno: num(r.sem_data) };
}

/** Pedidos de pagamento e perda por grupo com colunas de apoio ao ticket médio. */
export function ticketMedio(m: Pick<Metricas, 'pedidos' | 'brutoCentavos' | 'receitaCentavos'>, modo: FiltroResolvido['modo']): number {
  if (m.pedidos === 0) return 0;
  return Math.round((modo === 'APROVADAS' ? m.receitaCentavos : m.brutoCentavos) / m.pedidos);
}
