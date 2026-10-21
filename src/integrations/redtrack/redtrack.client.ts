import { env } from '../../config/env';

export type FonteInvestimento = 'REDTRACK' | 'NAO_CONFIGURADO' | 'ERRO';

export interface InvestimentoResultado {
  fonte: FonteInvestimento;
  /** investimento em anúncios; null quando a fonte não está disponível (nunca 0 inventado) */
  centavos: number | null;
  /** Faturamento do tráfego (revenuetype 2+3) e compras (convtype2): a base da DRE */
  faturamentoCentavos?: number | null;
  /** downsells (revenuetype 6–9): fora do faturamento do tráfego, somados no "Front Revenue" do Copy */
  downsellsCentavos?: number | null;
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

/**
 * Faturamento do tráfego (DRE) = vendas principais + upsell atribuídos à campanha (revenuetype2 + 3). Medido em 01–19/10/2026:
 * 2.013.441,13 = o valor do sistema anterior. O "Front Revenue" do Copy soma também os downsells (revenuetype6 a 9): +R$ 1.732,02.
 */
const FATURAMENTO = ['revenuetype2', 'revenuetype3'] as const;
const DOWNSELLS = ['revenuetype6', 'revenuetype7', 'revenuetype8', 'revenuetype9'] as const;

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { em: number; valor: InvestimentoResultado }>();

export function limparCacheRedtrack(): void {
  cache.clear();
}

/** Soma o custo (anúncios) das ofertas cujo nome contém o filtro (padrão "pagah" = operação BR), em centavos. */
export function somarCusto(linhas: Linha[], filtroOferta: string): number {
  return somarRedtrack(linhas, filtroOferta).custoCentavos;
}

const cent = (v: Num): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** Soma custo, faturamento Front e compras das ofertas que casam com o filtro (soma por linha, em centavos inteiros). */
export function somarRedtrack(linhas: Linha[], filtroOferta: string): { custoCentavos: number; faturamentoCentavos: number; downsellsCentavos: number; compras: number } {
  const f = filtroOferta.toLowerCase();
  let custo = 0;
  let fat = 0;
  let down = 0;
  let compras = 0;
  for (const l of linhas) {
    if (!(l.offer ?? '').toLowerCase().includes(f)) continue;
    custo += cent(l.cost);
    for (const k of FATURAMENTO) fat += cent(l[k]);
    for (const k of DOWNSELLS) down += cent(l[k]);
    const n = Number(l.convtype2 ?? 0);
    if (Number.isFinite(n)) compras += Math.round(n);
  }
  return { custoCentavos: custo, faturamentoCentavos: fat, downsellsCentavos: down, compras };
}

/**
 * Investimento em anúncios no período (RedTrack /report, fuso America/Sao_Paulo). A chave vem só do ambiente
 * (REDTRACK_API_KEY) e nunca é logada nem devolvida. Falha ou ausência de chave => centavos null + motivo.
 */
export async function investimentoNoPeriodo(de: string, ate: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<InvestimentoResultado> {
  const key = env.REDTRACK_API_KEY;
  if (!key) return { fonte: 'NAO_CONFIGURADO', centavos: null, mensagem: 'Chave do RedTrack não configurada no servidor (REDTRACK_API_KEY).' };

  const ck = `${de}|${ate}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.em < CACHE_TTL_MS) return hit.valor;

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
    const valor: InvestimentoResultado = { fonte: 'REDTRACK', centavos: t.custoCentavos, faturamentoCentavos: t.faturamentoCentavos, downsellsCentavos: t.downsellsCentavos, compras: t.compras };
    cache.set(ck, { em: Date.now(), valor });
    return valor;
  } catch (e) {
    const abortou = (e as { name?: string }).name === 'AbortError';
    return { fonte: 'ERRO', centavos: null, mensagem: abortou ? 'RedTrack demorou demais para responder.' : 'Falha de rede ao consultar o RedTrack.' };
  } finally {
    clearTimeout(timer);
  }
}
