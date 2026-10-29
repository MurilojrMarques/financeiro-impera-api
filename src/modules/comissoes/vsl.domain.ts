/**
 * Comissão por VSL: porte de `tools/base_vsl.py` do comissionamento-copywriters (decisões 033, 034 e 036 de lá).
 * Pura (sem I/O): recebe as linhas do RedTrack por network,campaign,landing e devolve o MC BR por VSL, por gestor e o total.
 * A "VSL" é uma chave proposta pelo nome da landing (nicho + oferta + produto + vslNN da URL); quem é o dono e o editor de cada
 * uma vem do cadastro (`comissao_vsl`), porque isso é decisão do negócio e não está no RedTrack.
 */
export const NICHOS: ReadonlySet<string> = new Set(['EM', 'DB', 'NE', 'MM', 'DA', 'ED', 'PT', 'ZB', 'VS']);

/** O mesmo produto escrito de jeitos diferentes no nome da landing. */
const ALIAS_PRODUTO: Record<string, string> = { MEMOKARE: 'MEMO KARE', MMOKARE: 'MEMO KARE', NEUROSILENCE: 'NEURO SILENCE', GDMR01: 'GLICO DROPS' };

/** O nicho que a campanha diz (a ordem importa: vale a primeira palavra que aparece no nome). */
const NICHO_DA_CAMPANHA: ReadonlyArray<readonly [string, string]> = [
  ['DORES', 'DA'], ['NEUROPATIA', 'NE'], ['DIABETES', 'DB'], ['MEMORIA', 'MM'], ['MEMÓRIA', 'MM'], ['EMAGRECIMENTO', 'EM'], ['ADULTO', 'ED'],
  ['PROSTATA', 'PT'], ['PRÓSTATA', 'PT'], ['VISAO', 'VS'], ['VISÃO', 'VS'],
];

const GESTOR_ALIAS: Record<string, string> = { DOUG: 'DOUGLAS', JOAO: 'JOÃO' };

/** O gestor põe o nome no fim da campanha ("G. DOUG"); [WAN] (Taboola e MGID) é sempre o Wanderson. */
export function gestorDaCampanha(campanha: string): string {
  if (campanha.trim().toUpperCase().startsWith('[WAN]')) return 'WANDERSON';
  const m = /\bG\.\s*([A-Za-zÀ-ú]+)/.exec(campanha);
  const g = m ? m[1]!.toUpperCase() : '?';
  return GESTOR_ALIAS[g] ?? g;
}

export interface ChaveVsl {
  vsl: string;
  nicho: string;
  oferta: string;
  produto: string;
}

/** Chave da VSL a partir do nome da landing, que carrega tudo: `[FB][NE][BR][OF04][VT][LD12] - Nerve Pure - https://…/np/of04/lead12/ | 26/09/26`. */
export function chaveVsl(nome: string): ChaveVsl {
  const tags = [...nome.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
  const nicho = tags.find((t) => NICHOS.has(t)) ?? '?';
  const url = /https?:\/\/[^/\s]+(\/[^\s|]*)/.exec(nome);
  const path = url ? url[1]!.toLowerCase() : '';
  const ofNome = tags.find((t) => /^OFC?\d+$/.test(t)) ?? '';
  const mUrl = /\/(ofc?\d+)(?:\/|$)/.exec(path);
  const ofUrl = mUrl ? mUrl[1]!.toUpperCase().replace(/(\D+)(\d+)/g, (_, a: string, d: string) => `${a}${String(parseInt(d, 10)).padStart(2, '0')}`) : '';
  let oferta = ofNome || ofUrl || '?';
  // Número diferente entre o nome e a URL: vale a URL, que é a página que está no ar (OF05 x OFC05 é o mesmo número e fica o do nome).
  if (ofNome && ofUrl && parseInt(ofNome.replace(/\D/g, ''), 10) !== parseInt(ofUrl.replace(/\D/g, ''), 10)) oferta = ofUrl;
  const prod = /-\s*([^[\]\-|]+?)\s*-\s*https?:\/\//.exec(nome) ?? /\[(?:[^\]]* - )?([^\]]+)\]\s*-\s*https?:\/\//.exec(nome);
  let produto = prod ? prod[1]!.trim().toUpperCase() : '?';
  produto = ALIAS_PRODUTO[produto.replace(/ /g, '')] ?? produto;
  const partes = [nicho, oferta, produto];
  const vsl = /\/(vsl\d+)(?:\/|$)/.exec(path);
  if (path.includes('/mini')) partes.push('MINI-VSL');
  else if (vsl) partes.push(vsl[1]!.toUpperCase());
  return { vsl: partes.join(' '), nicho, oferta, produto };
}

export interface LinhaRedtrackLanding {
  network: string;
  campaignId: string;
  campaign: string;
  landing: string;
  /** reais */
  cost: number;
  /** Front + Upsell 1 + Downsell 1 + Downsell 2 (revenuetype 2, 3, 6 e 7), em reais */
  rev: number;
}

export interface LinhaVsl {
  vsl: string;
  gestor: string;
  /** MC BR da linha, em reais: base × 0,70 − investimento × 1,10 */
  mc: number;
  cost: number;
  rev: number;
}

const nichoDaCampanha = (campanha: string): string => NICHO_DA_CAMPANHA.find(([palavra]) => campanha.toUpperCase().includes(palavra))?.[1] ?? '?';

/**
 * Uma linha por (campanha, landing) da rede pedida. `mesma`: VSL → VSL em que ela se junta (oferta cadastrada com o número errado).
 * Presell de nativo sem landing: o nicho da campanha decide, e a chave vira "<NICHO> SEM LANDING".
 */
export function linhasPorVsl(linhas: LinhaRedtrackLanding[], network: string, mesma: Record<string, string> = {}): LinhaVsl[] {
  const rede = network.trim().toLowerCase();
  const out: LinhaVsl[] = [];
  for (const r of linhas) {
    if (r.cost === 0 && r.rev === 0) continue;
    if (r.network.trim().toLowerCase() !== rede) continue;
    const nome = r.landing.trim();
    let vsl: string;
    if (nome) {
      const c = chaveVsl(nome);
      vsl = c.vsl;
    } else {
      vsl = `${nichoDaCampanha(r.campaign)} SEM LANDING`;
    }
    out.push({ vsl: mesma[vsl] ?? vsl, gestor: gestorDaCampanha(r.campaign), mc: r.rev * 0.7 - r.cost * 1.1, cost: r.cost, rev: r.rev });
  }
  return out;
}
