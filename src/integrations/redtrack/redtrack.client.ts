import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { businessDateString } from '../../shared/utils/dates';

export type FonteInvestimento = 'REDTRACK' | 'NAO_CONFIGURADO' | 'ERRO';

export interface InvestimentoResultado {
  fonte: FonteInvestimento;
  /** investimento em anúncios; null quando a fonte não está disponível (nunca 0 inventado) */
  centavos: number | null;
  /** Faturamento do tráfego (revenuetype 2+3) e compras (convtype2): só referência na conferência de fontes */
  faturamentoCentavos?: number | null;
  /** downsells (revenuetype 6–9): fora do faturamento do tráfego */
  downsellsCentavos?: number | null;
  /** Front + Upsell 1 + Downsell 1 + Downsell 2 (revenuetype2+3+6+7): base do MC BR */
  baseMcBrCentavos?: number | null;
  /** "Front Revenue" do RedTrack: Front + Upsell + Downsells (revenuetype 2, 3 e 6–9), arredondado uma vez só */
  frontRevenueCentavos?: number | null;
  /** MC BR calculado sobre os valores exatos do RedTrack, arredondado uma vez só (igual à coluna MC BR da plataforma) */
  mcBrCentavos?: number | null;
  compras?: number | null;
  mensagem?: string;
}

type Num = number | string | undefined;
interface Linha {
  offer?: string;
  cost?: Num;
  convtype2?: Num;
  revenuetype2?: Num;
  revenuetype3?: Num;
  revenuetype6?: Num;
  revenuetype7?: Num;
  revenuetype8?: Num;
  revenuetype9?: Num;
}

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Faturamento do tráfego (DRE) = vendas principais + upsell atribuídos à campanha (revenuetype2 + 3). Medido em 01–19/10/2026:
 * 2.013.441,13 = o valor do sistema anterior. O "Front Revenue" do Copy soma também os downsells (revenuetype6 a 9): +R$ 1.732,02.
 */
const FATURAMENTO = ['revenuetype2', 'revenuetype3'] as const;
/** MC BR = (Front + Upsell 1 + Downsell 1 + Downsell 2) × 0,70 − investimento × 1,10 */
const MC_BR = ['revenuetype2', 'revenuetype3', 'revenuetype6', 'revenuetype7'] as const;
const DOWNSELLS = ['revenuetype6', 'revenuetype7', 'revenuetype8', 'revenuetype9'] as const;

// ── Cache (stale-while-revalidate) ─────────────────────────────────────────────────────────────────────────────────────────
/** Períodos que incluem hoje mudam o tempo todo; períodos já fechados praticamente não mudam. */
const TTL_ABERTO_MS = 10 * 60_000;
const TTL_FECHADO_MS = 6 * 3_600_000;
/** Mesmo vencido, o valor guardado ainda é devolvido na hora (e atualizado em segundo plano) por até 24 h. */
const MAX_VELHO_MS = 24 * 3_600_000;

interface Entrada {
  em: number;
  valor: InvestimentoResultado;
}
const cache = new Map<string, Entrada>();
const emVoo = new Map<string, Promise<InvestimentoResultado>>();

export function limparCacheRedtrack(): void {
  cache.clear();
  emVoo.clear();
}

/** Soma custo, faturamento Front e compras das ofertas que casam com o filtro (soma por linha, em centavos inteiros). */
export function somarCusto(linhas: Linha[], filtroOferta: string): number {
  return somarRedtrack(linhas, filtroOferta).custoCentavos;
}

/** Valor em reais (com todas as casas que o RedTrack mandar); o arredondamento para centavos só acontece no total. */
const reais = (v: Num): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** Arredonda UMA vez, no total: arredondar cada linha antes de somar acumula centavos de diferença em relação à plataforma. */
const paraCentavos = (reaisExatos: number): number => Math.round(reaisExatos * 100 + 1e-6);

export function somarRedtrack(
  linhas: Linha[],
  filtroOferta: string,
): { custoCentavos: number; faturamentoCentavos: number; downsellsCentavos: number; frontRevenueCentavos: number; baseMcBrCentavos: number; mcBrCentavos: number; compras: number } {
  const f = filtroOferta.toLowerCase();
  let custo = 0;
  let fat = 0;
  let down = 0;
  let base = 0;
  let compras = 0;
  for (const l of linhas) {
    if (!(l.offer ?? '').toLowerCase().includes(f)) continue;
    custo += reais(l.cost);
    for (const k of FATURAMENTO) fat += reais(l[k]);
    for (const k of DOWNSELLS) down += reais(l[k]);
    for (const k of MC_BR) base += reais(l[k]);
    const n = Number(l.convtype2 ?? 0);
    if (Number.isFinite(n)) compras += Math.round(n);
  }
  return {
    custoCentavos: paraCentavos(custo),
    faturamentoCentavos: paraCentavos(fat),
    downsellsCentavos: paraCentavos(down),
    frontRevenueCentavos: paraCentavos(fat + down),
    baseMcBrCentavos: paraCentavos(base),
    mcBrCentavos: paraCentavos(base * 0.7 - custo * 1.1),
    compras,
  };
}

/** Uma consulta de verdade ao RedTrack. A chave só existe no ambiente e nunca é logada nem devolvida. */
async function consultar(de: string, ate: string, fetcher: Fetcher): Promise<InvestimentoResultado> {
  const key = env.REDTRACK_API_KEY as string;
  const params = new URLSearchParams({ date_from: de, date_to: ate, group: 'campaign,offer', timezone: 'America/Sao_Paulo', per: '5000', api_key: key });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), env.REDTRACK_TIMEOUT_MS);
  try {
    const res = await fetcher(`${env.REDTRACK_BASE_URL.replace(/\/+$/, '')}/report?${params.toString()}`, { signal: ctl.signal });
    if (!res.ok) return { fonte: 'ERRO', centavos: null, mensagem: `RedTrack respondeu HTTP ${res.status}.` };
    const body = (await res.json()) as unknown;
    const itens = Array.isArray(body) ? body : ((body as { items?: unknown; data?: unknown })?.items ?? (body as { data?: unknown })?.data);
    if (!Array.isArray(itens)) return { fonte: 'ERRO', centavos: null, mensagem: 'Resposta do RedTrack fora do formato esperado.' };
    const t = somarRedtrack(itens as Linha[], env.REDTRACK_OFFER_FILTER);
    return { fonte: 'REDTRACK', centavos: t.custoCentavos, faturamentoCentavos: t.faturamentoCentavos, downsellsCentavos: t.downsellsCentavos, frontRevenueCentavos: t.frontRevenueCentavos, baseMcBrCentavos: t.baseMcBrCentavos, mcBrCentavos: t.mcBrCentavos, compras: t.compras };
  } catch (e) {
    const abortou = (e as { name?: string }).name === 'AbortError';
    return { fonte: 'ERRO', centavos: null, mensagem: abortou ? 'RedTrack demorou demais para responder.' : 'Falha de rede ao consultar o RedTrack.' };
  } finally {
    clearTimeout(timer);
  }
}

/** Uma única consulta por período ao mesmo tempo (várias telas pedindo o mesmo período não multiplicam chamadas). */
function atualizar(ck: string, de: string, ate: string, fetcher: Fetcher): Promise<InvestimentoResultado> {
  const atual = emVoo.get(ck);
  if (atual) return atual;
  const p = consultar(de, ate, fetcher)
    .then((valor) => {
      if (valor.fonte === 'REDTRACK') cache.set(ck, { em: Date.now(), valor }); // erro nunca é guardado
      return valor;
    })
    .finally(() => emVoo.delete(ck));
  emVoo.set(ck, p);
  return p;
}

/**
 * Investimento em anúncios no período (RedTrack /report, fuso America/Sao_Paulo). Sem chave => indisponível.
 * Cache com atualização em segundo plano: depois da primeira consulta a tela nunca espera o RedTrack (que leva alguns segundos);
 * quando o valor vence, ele é devolvido na hora e renovado por trás. Se o RedTrack falhar, o último valor bom continua valendo.
 */
export async function investimentoNoPeriodo(de: string, ate: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<InvestimentoResultado> {
  if (!env.REDTRACK_API_KEY) return { fonte: 'NAO_CONFIGURADO', centavos: null, mensagem: 'Chave do RedTrack não configurada no servidor (REDTRACK_API_KEY).' };

  const ck = `${de}|${ate}`;
  const e = cache.get(ck);
  if (e) {
    const idade = Date.now() - e.em;
    const ttl = ate < businessDateString(new Date()) ? TTL_FECHADO_MS : TTL_ABERTO_MS;
    if (idade < ttl) return e.valor;
    if (idade < MAX_VELHO_MS) {
      void atualizar(ck, de, ate, fetcher).catch((err) => logger.warn({ erro: err instanceof Error ? err.message : String(err) }, 'renovação do RedTrack em segundo plano falhou'));
      return e.valor;
    }
  }
  return atualizar(ck, de, ate, fetcher);
}

/** Aquece o cache dos períodos mais usados (mês atual), para a primeira abertura do dia já nascer rápida. */
export async function aquecerInvestimento(fetcher?: Fetcher): Promise<void> {
  if (!env.REDTRACK_API_KEY) return;
  const hoje = businessDateString(new Date());
  const primeiro = `${hoje.slice(0, 8)}01`;
  await investimentoNoPeriodo(primeiro, hoje, fetcher);
}
