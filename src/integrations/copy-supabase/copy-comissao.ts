import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Comissão do Front = a do sistema de copy (comissionamento): 5% do MC BR de cada pessoa que fez a versão do criativo que rodou
 * (decisão 028, vale de 01/08/2026 em diante; mesma conta de `hefesto.meu_mc`). A base vem de `public.vw_ads_dia` do Supabase do
 * comissionamento, SOMENTE LEITURA. Aqui não se refaz autoria nem MC BR: muda lá, muda aqui.
 *  - "Sem dono" e quem não é comissionável (EMPRESA) não recebem.
 *  - Apuração (como a aba do copy): conta os negativos, para somar 5% do MC BR. A pagar: piso em 0 por pessoa (quem fecha negativo recebe só o fixo, decisão 012).
 */
export const TAXA_COMISSAO_COPY = '0.05';
export const INICIO_REGRA_COPY = '2026-08-01';

export interface ComissaoCopyPessoa {
  copywriterId: string;
  nome: string;
  mcBrCentavos: number;
  /** 5% do MC BR da pessoa (pode ser negativa) */
  comissaoCentavos: number;
  /** o que se paga de fato: piso em 0 */
  aPagarCentavos: number;
}

export type ComissaoCopy =
  | {
      disponivel: true;
      /** soma das comissões apuradas (com negativos) */
      comissaoCentavos: number;
      /** soma do que se paga de fato (piso em 0 por pessoa) */
      aPagarCentavos: number;
      /** MC BR de quem recebe (comissionáveis) */
      mcBrComissionavelCentavos: number;
      /** MC BR sem dono + de quem não é comissionável: não gera comissão */
      mcBrSemComissaoCentavos: number;
      /** PROVISORIO: há dias ainda não fechados (custo do RedTrack em revisão) */
      estado: 'FECHADO' | 'PROVISORIO';
      pessoas: ComissaoCopyPessoa[];
    }
  | { disponivel: false; motivo: 'NAO_CONFIGURADO' | 'REGRA_ANTERIOR' | 'CORTA_MES_FECHADO' | 'ERRO'; mensagem: string };

export const copyConfigurado = (): boolean => !!env.SUPABASE_DB_URL_POOLER;

let pool: Pool | null = null;
function conexao(): Pool {
  if (pool) return pool;
  // a verificação do certificado usa a CA pública do Supabase (certs/); sem ela a conexão é recusada, nunca aceita às cegas
  const ca = readFileSync(resolve(process.cwd(), env.COPY_DB_CA_FILE), 'utf8');
  pool = new Pool({
    connectionString: env.SUPABASE_DB_URL_POOLER!.replace(/[?&]sslmode=[^&]*/, ''),
    ssl: { ca, rejectUnauthorized: true },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
  });
  pool.on('error', (e) => logger.warn({ err: e.message }, 'conexão ociosa com o banco do comissionamento caiu'));
  return pool;
}

export async function fecharCopy(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = null;
}

const centavos = (v: string | null): number => (v === null ? 0 : Math.round(Number(v) * 100));
const ultimoDiaDoMes = (primeiro: string): string => {
  const [a, m] = primeiro.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

/** Período que corta um mês já fechado no copy não é apurável: o fechado só existe inteiro. */
export function cortaMesFechado(de: string, ate: string, mesesFechados: string[]): string | null {
  for (const primeiro of mesesFechados) {
    const ultimo = ultimoDiaDoMes(primeiro);
    const sobrepoe = de <= ultimo && ate >= primeiro;
    if (sobrepoe && !(de <= primeiro && ate >= ultimo)) return primeiro.slice(0, 7);
  }
  return null;
}

const TTL_ABERTO_MS = 5 * 60_000;
const TTL_FECHADO_MS = 6 * 3_600_000;
const cache = new Map<string, { em: number; valor: ComissaoCopy; ttl: number }>();
export const limparCacheCopy = (): void => cache.clear();

export async function comissaoCopyNoPeriodo(de: string, ate: string): Promise<ComissaoCopy> {
  if (!copyConfigurado()) return { disponivel: false, motivo: 'NAO_CONFIGURADO', mensagem: 'Sistema de copy não configurado.' };
  if (de < INICIO_REGRA_COPY) {
    return { disponivel: false, motivo: 'REGRA_ANTERIOR', mensagem: 'A comissão de 5% do copy vale a partir de 01/08/2026; antes disso valia o rateio de 3% + 2%.' };
  }
  const chave = `${de}|${ate}`;
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < guardado.ttl) return guardado.valor;

  try {
    const valor = await consultar(de, ate);
    cache.set(chave, { em: Date.now(), valor, ttl: valor.disponivel && valor.estado === 'FECHADO' ? TTL_FECHADO_MS : TTL_ABERTO_MS });
    return valor;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'falha ao ler a comissão do sistema de copy');
    // um valor antigo ainda serve melhor que nada, mas só até 24 h
    if (guardado && Date.now() - guardado.em < 24 * 3_600_000) return guardado.valor;
    return { disponivel: false, motivo: 'ERRO', mensagem: 'Não foi possível ler a comissão do sistema de copy agora.' };
  }
}

async function consultar(de: string, ate: string): Promise<ComissaoCopy> {
  const c = await conexao().connect();
  try {
    await c.query('BEGIN READ ONLY');
    const fechados = await c.query<{ mes: string }>(`SELECT to_char(mes, 'YYYY-MM-DD') AS mes FROM public.fechamentos`);
    const corte = cortaMesFechado(de, ate, fechados.rows.map((r) => r.mes));
    if (corte) {
      return { disponivel: false, motivo: 'CORTA_MES_FECHADO', mensagem: `O período corta o mês fechado ${corte.slice(5)}/${corte.slice(0, 4)} no sistema de copy: use o mês inteiro ou só dias de um mês em aberto.` };
    }
    const porPessoa = await c.query<{ id: string | null; nome: string | null; comissionavel: boolean | null; mc: string; com: string; provisorios: string }>(
      `SELECT a.copywriter_id AS id, cw.nome, cw.comissionavel,
              round(sum(a.mc_br), 2)::text AS mc,
              round($3::numeric * sum(a.mc_br), 2)::text AS com,
              count(*) FILTER (WHERE a.estado = 'provisorio')::text AS provisorios
         FROM public.vw_ads_dia a
         LEFT JOIN public.copywriters cw ON cw.id = a.copywriter_id
        WHERE a.dia BETWEEN $1::date AND $2::date
        GROUP BY a.copywriter_id, cw.nome, cw.comissionavel`,
      [de, ate, TAXA_COMISSAO_COPY],
    );
    await c.query('COMMIT');

    const pessoas: ComissaoCopyPessoa[] = [];
    let semComissao = 0;
    let provisorios = 0;
    for (const r of porPessoa.rows) {
      provisorios += Number(r.provisorios);
      if (!r.id || !r.comissionavel) {
        semComissao += centavos(r.mc);
        continue;
      }
      const com = centavos(r.com);
      pessoas.push({ copywriterId: r.id, nome: r.nome ?? '—', mcBrCentavos: centavos(r.mc), comissaoCentavos: com, aPagarCentavos: Math.max(0, com) });
    }
    pessoas.sort((a, b) => b.comissaoCentavos - a.comissaoCentavos || a.nome.localeCompare(b.nome));
    return {
      disponivel: true,
      comissaoCentavos: pessoas.reduce((s, p) => s + p.comissaoCentavos, 0),
      aPagarCentavos: pessoas.reduce((s, p) => s + p.aPagarCentavos, 0),
      mcBrComissionavelCentavos: pessoas.reduce((s, p) => s + p.mcBrCentavos, 0),
      mcBrSemComissaoCentavos: semComissao,
      estado: provisorios > 0 ? 'PROVISORIO' : 'FECHADO',
      pessoas,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
