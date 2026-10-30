import { logger } from '../../config/logger';
import { conexao, copyConfigurado } from './copy-comissao';

/**
 * O bônus de lead e MLD confirmado no sistema de copy (`public.vw_bonus_lead`, migration 0013 do comissionamento), SOMENTE LEITURA.
 * O sistema SUGERE a lead que bateu o controle e o admin (Elias) CONFIRMA num botão; o banco do copy guarda quem decidiu e a quem vai, nunca o
 * valor: os R$ 500 são daqui. Só conta o que está `confirmado` e `paga` (lead da própria dona da VSL não paga). Se o copy já tem alguma
 * decisão (confirmada ou recusada) no mês, ele é a fonte do mês inteiro e o lançamento manual do RH não soma por cima; sem decisão (ou sem a
 * view), vale o que o RH lançou, como antes da 0013.
 */
export const VALOR_BONUS_LEAD_CENTAVOS = 50_000;

export type BonusLeadDoCopy =
  | { disponivel: true; itens: { copywriter: string; valorCentavos: number }[]; decididas: number }
  | { disponivel: false; motivo: 'NAO_CONFIGURADO' | 'SEM_VIEW' | 'SEM_DECISAO' | 'ERRO'; mensagem: string };

export interface LinhaBonus {
  autor_nome: string | null;
  pagas: string | number;
  decididas: string | number;
}

/** As linhas agrupadas por autora → a lista de bônus a pagar e quantas decisões o mês tem. */
export function montarBonusLead(rows: LinhaBonus[]): { itens: { copywriter: string; valorCentavos: number }[]; decididas: number } {
  const itens = rows
    .filter((r) => r.autor_nome && Number(r.pagas) > 0)
    .map((r) => ({ copywriter: r.autor_nome!, valorCentavos: Number(r.pagas) * VALOR_BONUS_LEAD_CENTAVOS }));
  return { itens, decididas: rows.reduce((s, r) => s + Number(r.decididas), 0) };
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { em: number; valor: BonusLeadDoCopy }>();
export const limparCacheCopyBonusLead = (): void => cache.clear();

/** `competencia` = AAAA-MM. */
export async function bonusLeadDoCopyNoMes(competencia: string): Promise<BonusLeadDoCopy> {
  if (!copyConfigurado()) return { disponivel: false, motivo: 'NAO_CONFIGURADO', mensagem: 'Sistema de copy não configurado.' };
  const guardado = cache.get(competencia);
  if (guardado && Date.now() - guardado.em < TTL_MS) return guardado.valor;
  try {
    const valor = await consultar(competencia);
    if (valor.disponivel) cache.set(competencia, { em: Date.now(), valor });
    return valor;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'falha ao ler o bônus de lead do sistema de copy');
    return { disponivel: false, motivo: 'ERRO', mensagem: 'Não foi possível ler o bônus de lead do sistema de copy agora.' };
  }
}

async function consultar(competencia: string): Promise<BonusLeadDoCopy> {
  const c = await conexao().connect();
  try {
    await c.query('BEGIN READ ONLY');
    const existe = await c.query<{ ok: string | null }>(`SELECT to_regclass('public.vw_bonus_lead')::text AS ok`);
    if (!existe.rows[0]?.ok) return { disponivel: false, motivo: 'SEM_VIEW', mensagem: 'O banco do copy ainda não tem o bônus de lead (migration 0013).' };
    const r = await c.query<LinhaBonus>(
      `SELECT autor_nome,
              count(*) FILTER (WHERE estado = 'confirmado' AND paga)::text AS pagas,
              count(*)::text AS decididas
         FROM public.vw_bonus_lead
        WHERE mes = ($1 || '-01')::date AND estado IN ('confirmado', 'recusado')
        GROUP BY autor_nome`,
      [competencia],
    );
    const m = montarBonusLead(r.rows);
    if (m.decididas === 0) return { disponivel: false, motivo: 'SEM_DECISAO', mensagem: 'O admin ainda não decidiu nenhum bônus de lead neste mês.' };
    return { disponivel: true, ...m };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
