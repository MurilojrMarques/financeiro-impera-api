import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { businessDateString } from '../../shared/utils/dates';
import type { LinhaRedtrackLanding } from '../../modules/comissoes/vsl.domain';
import type { Fetcher } from './redtrack.client';

/**
 * /report do RedTrack por network,campaign,landing (base da comissão por VSL, igual ao `_pull_all` do comissionamento-copywriters):
 * páginas de 1.000 até uma vir incompleta. Uma página que falha derruba o relatório inteiro: nunca devolve um total parcial.
 */
export type RelatorioLanding = { ok: true; linhas: LinhaRedtrackLanding[] } | { ok: false; mensagem: string };

const POR_PAGINA = 1000;
const MAX_PAGINAS = 29;
const TENTATIVAS_429 = 3;
const TTL_ABERTO_MS = 10 * 60_000;
const TTL_FECHADO_MS = 6 * 3_600_000;

const cache = new Map<string, { em: number; linhas: LinhaRedtrackLanding[] }>();
const emVoo = new Map<string, Promise<RelatorioLanding>>();
export const limparCacheRedtrackLanding = (): void => {
  cache.clear();
  emVoo.clear();
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const MC_BR = ['revenuetype2', 'revenuetype3', 'revenuetype6', 'revenuetype7'] as const;

function normalizar(l: Record<string, unknown>): LinhaRedtrackLanding {
  return {
    network: String(l.network ?? ''),
    campaignId: String(l.campaign_id ?? ''),
    campaign: String(l.campaign ?? ''),
    landing: String(l.landing ?? ''),
    cost: num(l.cost),
    rev: MC_BR.reduce((s, k) => s + num(l[k]), 0),
  };
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pagina(de: string, ate: string, page: number, fetcher: Fetcher): Promise<Record<string, unknown>[] | string> {
  const params = new URLSearchParams({ date_from: de, date_to: ate, group: 'network,campaign,landing', timezone: 'America/Sao_Paulo', per: String(POR_PAGINA), page: String(page), api_key: env.REDTRACK_API_KEY as string });
  for (let t = 1; t <= TENTATIVAS_429; t++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), env.REDTRACK_TIMEOUT_MS);
    try {
      const res = await fetcher(`${env.REDTRACK_BASE_URL.replace(/\/+$/, '')}/report?${params.toString()}`, { signal: ctl.signal });
      if (res.status === 429 && t < TENTATIVAS_429) {
        await esperar(2000 * t);
        continue;
      }
      if (!res.ok) return `RedTrack respondeu HTTP ${res.status}.`;
      const body = (await res.json()) as unknown;
      const itens = Array.isArray(body) ? body : ((body as { items?: unknown; data?: unknown })?.items ?? (body as { data?: unknown })?.data);
      if (!Array.isArray(itens)) return 'Resposta do RedTrack fora do formato esperado.';
      return itens as Record<string, unknown>[];
    } catch (e) {
      return (e as { name?: string }).name === 'AbortError' ? 'RedTrack demorou demais para responder.' : 'Falha de rede ao consultar o RedTrack.';
    } finally {
      clearTimeout(timer);
    }
  }
  return 'RedTrack respondeu HTTP 429.';
}

async function puxar(de: string, ate: string, fetcher: Fetcher): Promise<RelatorioLanding> {
  const linhas: LinhaRedtrackLanding[] = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const r = await pagina(de, ate, page, fetcher);
    if (typeof r === 'string') return { ok: false, mensagem: r };
    linhas.push(...r.map(normalizar));
    if (r.length < POR_PAGINA) return { ok: true, linhas };
  }
  return { ok: false, mensagem: 'O relatório por landing passou do limite de páginas; reduza o período.' };
}

export async function relatorioPorLanding(de: string, ate: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<RelatorioLanding> {
  if (!env.REDTRACK_API_KEY) return { ok: false, mensagem: 'Chave do RedTrack não configurada no servidor (REDTRACK_API_KEY).' };
  const ck = `${de}|${ate}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.em < (ate < businessDateString(new Date()) ? TTL_FECHADO_MS : TTL_ABERTO_MS)) return { ok: true, linhas: e.linhas };
  const atual = emVoo.get(ck);
  if (atual) return atual;
  const p = puxar(de, ate, fetcher)
    .then((r) => {
      if (r.ok) cache.set(ck, { em: Date.now(), linhas: r.linhas });
      else logger.warn({ mensagem: r.mensagem }, 'relatório por landing do RedTrack falhou');
      return r;
    })
    .finally(() => emVoo.delete(ck));
  emVoo.set(ck, p);
  return p;
}
