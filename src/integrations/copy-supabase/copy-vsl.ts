import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { VslCadastro } from '../../modules/comissoes/comissao-front';
import type { LinhaVsl } from '../../modules/comissoes/vsl.domain';
import { conexao, copyConfigurado } from './copy-comissao';

/**
 * O MC BR por VSL, com dono e editor, do sistema de copy (`public.vw_vsl_dia`, migration 0014 do comissionamento), SOMENTE LEITURA.
 * Aqui não se refaz a chave da VSL, o gestor nem o dono: o banco do copy guarda o retrato do RedTrack por landing, a troca de gestor
 * e a decisão de dono e editor (que o Hefesto ou o admin registram, nunca o RH), e muda lá, muda aqui. Sem a view ou sem dado do
 * período, quem chama volta ao RedTrack direto com o cadastro local: nada quebra antes da 0014 estar em produção e carregada.
 */
export type VslDoCopy =
  | { disponivel: true; linhas: LinhaVsl[]; cadastro: VslCadastro[] }
  | { disponivel: false; motivo: 'NAO_CONFIGURADO' | 'SEM_VIEW' | 'SEM_DADO' | 'ERRO'; mensagem: string };

export interface LinhaDaView {
  vsl: string;
  gestor: string;
  copywriter_nome: string | null;
  editor: string | null;
  mc: string;
}

/** As linhas da view (somadas por VSL, gestor, dono e editor) → o que o motor de comissão consome. */
export function montarVslDoCopy(rows: LinhaDaView[]): { linhas: LinhaVsl[]; cadastro: VslCadastro[] } {
  const cadastro = new Map<string, VslCadastro>();
  const linhas: LinhaVsl[] = [];
  for (const r of rows) {
    linhas.push({ vsl: r.vsl, gestor: r.gestor, mc: Number(r.mc), cost: 0, rev: 0 });
    // dono e editor são da VSL (o cadastro é um por VSL), então todas as linhas dela trazem os mesmos
    if (!cadastro.has(r.vsl)) cadastro.set(r.vsl, { chave: r.vsl, dono: r.copywriter_nome ? r.copywriter_nome.toUpperCase() : null, editor: r.editor, mesmaVsl: null });
  }
  return { linhas, cadastro: [...cadastro.values()] };
}

const TTL_ABERTO_MS = 5 * 60_000;
const cache = new Map<string, { em: number; valor: VslDoCopy; ttl: number }>();
export const limparCacheCopyVsl = (): void => cache.clear();

export async function vslDoCopyNoPeriodo(de: string, ate: string): Promise<VslDoCopy> {
  if (!copyConfigurado()) return { disponivel: false, motivo: 'NAO_CONFIGURADO', mensagem: 'Sistema de copy não configurado.' };
  if (!env.COMISSAO_VSL_DO_COPY) return { disponivel: false, motivo: 'NAO_CONFIGURADO', mensagem: 'A VSL do sistema de copy está em teste e desligada na comissão (COMISSAO_VSL_DO_COPY).' };
  const chave = `${de}|${ate}`;
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < guardado.ttl) return guardado.valor;
  try {
    const valor = await consultar(de, ate);
    // o que não é dado (view ausente, mês sem carga) não se guarda: a carga pode chegar a qualquer momento
    if (valor.disponivel) cache.set(chave, { em: Date.now(), valor, ttl: TTL_ABERTO_MS });
    return valor;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'falha ao ler as VSLs do sistema de copy');
    if (guardado && Date.now() - guardado.em < 24 * 3_600_000) return guardado.valor;
    return { disponivel: false, motivo: 'ERRO', mensagem: 'Não foi possível ler as VSLs do sistema de copy agora.' };
  }
}

async function consultar(de: string, ate: string): Promise<VslDoCopy> {
  const c = await conexao().connect();
  try {
    await c.query('BEGIN READ ONLY');
    const existe = await c.query<{ ok: string | null }>(`SELECT to_regclass('public.vw_vsl_dia')::text AS ok`);
    if (!existe.rows[0]?.ok) return { disponivel: false, motivo: 'SEM_VIEW', mensagem: 'O banco do copy ainda não tem as VSLs (migration 0014).' };
    const r = await c.query<LinhaDaView>(
      `SELECT vsl, gestor, copywriter_nome, editor, sum(mc_br)::text AS mc
         FROM public.vw_vsl_dia
        WHERE dia BETWEEN $1::date AND $2::date
        GROUP BY vsl, gestor, copywriter_nome, editor`,
      [de, ate],
    );
    if (r.rows.length === 0) return { disponivel: false, motivo: 'SEM_DADO', mensagem: 'O banco do copy não tem VSL neste período.' };
    return { disponivel: true, ...montarVslDoCopy(r.rows) };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
