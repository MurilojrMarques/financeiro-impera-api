import { normalizeHeader, sha256 } from '../../shared/utils/text';

export type TabKey = 'EVENTOS' | 'HISTORICO' | 'REDTRACK';

interface FieldSpec {
  aliases: string[];
  required: boolean;
}

/**
 * Mapeamento campo canônico -> possíveis cabeçalhos (já normalizados: minúsculo, sem acento, `_`).
 * Os cabeçalhos REAIS são lidos da planilha; este mapa só diz como reconhecê-los.
 * Para estender sem alterar código: SHEET_HEADER_ALIASES_JSON='{"HISTORICO":{"atendente":["operador_cc"]}}'
 */
export const DEFAULT_FIELDS: Record<TabKey, Record<string, FieldSpec>> = {
  EVENTOS: {
    recebido_em: { aliases: ['recebido_em'], required: false },
    pago_em: { aliases: ['pago_em'], required: false },
    evento: { aliases: ['evento'], required: true },
    pedido: { aliases: ['pedido', 'numero_do_pedido', 'n_pedido'], required: true },
    tipo: { aliases: ['tipo'], required: false },
    cliente_id: { aliases: ['cliente_id', 'id_cliente'], required: false },
    afiliado: { aliases: ['afiliado', 'nome_do_afiliado'], required: false },
    loja: { aliases: ['loja'], required: false },
    checkout: { aliases: ['checkout'], required: false },
    produto: { aliases: ['produto', 'kit'], required: false },
    valor_total: { aliases: ['valor_total'], required: false },
    valor_sem_juros: { aliases: ['valor_sem_juros'], required: true },
    valor_liquido: { aliases: ['valor_liquido'], required: false },
    comissao: { aliases: ['comissao'], required: false },
    comissao_fonte: { aliases: ['comissao_fonte'], required: false },
    metodo: { aliases: ['metodo', 'metodo_de_pagamento'], required: false },
    parcelas: { aliases: ['parcelas'], required: false },
    utm_source: { aliases: ['utm_source'], required: false },
    utm_campaign: { aliases: ['utm_campaign'], required: false },
    utm_content: { aliases: ['utm_content'], required: false },
    src: { aliases: ['src'], required: false },
    teste: { aliases: ['teste'], required: false },
    canal: { aliases: ['canal'], required: false },
    subcanal: { aliases: ['subcanal', 'sub_canal'], required: false },
    origem_lead: { aliases: ['origem_lead', 'origem_do_lead'], required: false },
    // lido apenas para extrair id_user_venda e valor_taxa_callcenter; o restante do JSON é descartado (ver extrairVendedorDoPayload)
    payload: { aliases: ['payload_sem_dados_pessoais', 'payload'], required: false },
  },
  HISTORICO: {
    pedido: { aliases: ['pedido', 'numero_do_pedido', 'numero_pedido', 'n_pedido', 'n_do_pedido', 'id_do_pedido'], required: true },
    status: { aliases: ['status', 'situacao'], required: true },
    data_criacao: { aliases: ['data_de_criacao', 'data_criacao', 'criado_em', 'data_do_pedido'], required: false },
    data_pagamento: { aliases: ['data_de_pagamento', 'data_pagamento', 'data_do_pagamento', 'pago_em'], required: false },
    data_estorno: { aliases: ['data_de_estorno', 'data_estorno', 'data_do_estorno', 'estornado_em'], required: false },
    tipo: { aliases: ['tipo_de_venda', 'tipo_venda', 'tipo'], required: false },
    origem: { aliases: ['origem'], required: false },
    tipo_atendimento: { aliases: ['tipo_de_atendimento', 'tipo_atendimento'], required: false },
    atendente: { aliases: ['atendente', 'operador', 'nome_do_atendente'], required: false },
    loja: { aliases: ['loja'], required: false },
    produto: { aliases: ['produto', 'kit', 'produto_kit', 'produto_ou_kit', 'nome_do_kit'], required: false },
    metodo: { aliases: ['metodo_de_pagamento', 'metodo_pagamento', 'metodo', 'forma_de_pagamento'], required: false },
    valor_total: { aliases: ['valor_total', 'valor_total_r'], required: false },
    valor_sem_juros: { aliases: ['valor_sem_juros', 'valor_sem_juros_r'], required: true },
    juros: { aliases: ['juros', 'juros_r', 'valor_juros'], required: false },
    comissao: { aliases: ['comissao', 'comissao_r', 'minha_comissao'], required: false },
    taxa_call_center: { aliases: ['taxa_do_call_center', 'taxa_call_center', 'taxa_callcenter', 'taxa_cc'], required: false },
    comissao_afiliado: { aliases: ['comissao_afiliado'], required: false },
    campanha: { aliases: ['campanha', 'utm_campaign'], required: false },
    click_id: { aliases: ['click_id', 'clickid'], required: false },
    afiliado: { aliases: ['nome_do_afiliado', 'afiliado', 'nome_afiliado'], required: false },
  },
  REDTRACK: {
    pedido: { aliases: ['pedido', 'numero_do_pedido', 'order_id', 'sub_id'], required: true },
    conversao: { aliases: ['conversao', 'rt_conversao', 'conversion', 'conversion_id', 'tipo_de_conversao'], required: false },
    payout: { aliases: ['payout', 'rt_payout', 'pagamento', 'valor_payout'], required: false },
    situacao: { aliases: ['situacao', 'situacao_da_conciliacao', 'conciliacao', 'status'], required: false },
    campanha: { aliases: ['campanha', 'rt_campanha', 'campaign'], required: false },
    anuncio: { aliases: ['anuncio', 'rt_anuncio', 'ad', 'creative'], required: false },
  },
};

export type AliasOverrides = Partial<Record<TabKey, Record<string, string[]>>>;

export function parseAliasOverrides(json: string | undefined): AliasOverrides {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as AliasOverrides;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('SHEET_HEADER_ALIASES_JSON inválido (JSON malformado)');
  }
}

export interface ColumnMap {
  tab: TabKey;
  /** campo canônico -> índice da coluna */
  indices: Record<string, number>;
  ausentesObrigatorios: string[];
  ausentesOpcionais: string[];
  /** cabeçalhos reais que não correspondem a nenhum campo conhecido (possível coluna nova/alterada) */
  desconhecidos: string[];
  assinatura: string;
  cabecalhosNormalizados: string[];
}

export function buildColumnMap(tab: TabKey, headers: unknown[], overrides: AliasOverrides = {}): ColumnMap {
  const normalized = headers.map((h) => normalizeHeader(h));
  const spec = DEFAULT_FIELDS[tab];
  const extra = overrides[tab] ?? {};
  const indices: Record<string, number> = {};
  const usados = new Set<number>();
  const ausentesObrigatorios: string[] = [];
  const ausentesOpcionais: string[] = [];

  for (const [campo, def] of Object.entries(spec)) {
    const aliases = [...def.aliases, ...(extra[campo] ?? []).map(normalizeHeader)];
    let idx = -1;
    for (const alias of aliases) {
      idx = normalized.findIndex((h, i) => h === alias && !usados.has(i));
      if (idx !== -1) break;
    }
    if (idx === -1) {
      (def.required ? ausentesObrigatorios : ausentesOpcionais).push(campo);
    } else {
      indices[campo] = idx;
      usados.add(idx);
    }
  }
  const desconhecidos = normalized.filter((h, i) => h !== '' && !usados.has(i));
  return {
    tab,
    indices,
    ausentesObrigatorios,
    ausentesOpcionais,
    desconhecidos,
    assinatura: sha256(normalized.join('|')),
    cabecalhosNormalizados: normalized,
  };
}

/** Linha bruta (array) -> registro com campos canônicos (string | null). Não confia em posição fixa. */
export function rowToRecord(row: unknown[], map: ColumnMap): Record<string, string | null> {
  const rec: Record<string, string | null> = {};
  // Campos opcionais cuja coluna não existe na planilha entram como null (ausente), nunca como erro.
  for (const campo of Object.keys(DEFAULT_FIELDS[map.tab])) {
    const idx = map.indices[campo];
    const v = idx === undefined ? undefined : row[idx];
    rec[campo] = v === undefined || v === null ? null : String(v);
  }
  return rec;
}

export function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => c === undefined || c === null || String(c).trim() === '');
}
