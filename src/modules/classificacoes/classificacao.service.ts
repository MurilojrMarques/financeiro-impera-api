import type { CampoClassificacao, OperadorClassificacao, TipoGrupo, TipoVenda } from '../../generated/prisma/client';
import { searchKey } from '../../shared/utils/text';

/**
 * Classificação de receita em grupos mutuamente exclusivos.
 *
 * Precedência (documentada em docs/REGRAS-FINANCEIRAS.md):
 *   0. CANAL DA PLANILHA — coluna `canal` do EVENTOS (front, call center, recuperação de vendas, back end, afiliado) decide, pois a
 *      venda fica com quem fechou. Só valores desconhecidos/ausentes seguem para as regras abaixo.
 *   1. AFILIADO         — campo `afiliado` preenchido (regra existente no Python)
 *   2. CALL_CENTER      — tipo = "call center" (regra existente no Python)
 *   3. Regras cadastradas (RegraClassificacao, por prioridade) — única via para BACKEND_OUTROS
 *   4. FRONT            — tipo front / upsell / downsell
 *   5. NAO_CLASSIFICADA — nenhum critério confiável
 *
 * Nada é inferido de nomes de produto/campanha: só regras explícitas e auditáveis.
 */

export interface RegraClassificacaoInput {
  id: string;
  campo: CampoClassificacao;
  operador: OperadorClassificacao;
  valor: string;
  grupo: TipoGrupo;
  prioridade: number;
  versao: number;
}

export interface ClassificacaoInput {
  afiliadoNome: string | null;
  tipoBruto: string | null; // coluna `tipo` / "Tipo da venda"
  kitNome: string | null;
  origem: string | null;
  tipoAtendimento: string | null;
  loja: string | null;
  campanha: string | null;
  utmSource: string | null;
  src: string | null;
  checkout: string | null;
  /** coluna `canal` do EVENTOS: quem fechou a venda (fonte de verdade quando presente) */
  canalPlanilha?: string | null;
  subcanal?: string | null;
}

export interface ClassificacaoResultado {
  grupo: TipoGrupo;
  tipoVenda: TipoVenda;
  motivo: string;
  regraId: string | null;
}

export function derivarTipoVenda(tipoBruto: string | null, kitNome: string | null): TipoVenda {
  const kit = searchKey(kitNome);
  if (kit?.startsWith('(downsell)')) return 'DOWNSELL';
  switch (searchKey(tipoBruto)) {
    case 'front':
      return 'FRONT';
    case 'upsell':
      return 'UPSELL';
    case 'downsell':
      return 'DOWNSELL';
    case 'call center':
      return 'CALL_CENTER';
    default:
      return 'OUTRO';
  }
}

function campoValor(i: ClassificacaoInput, campo: CampoClassificacao): string | null {
  switch (campo) {
    case 'ORIGEM':
      return i.origem;
    case 'TIPO_ATENDIMENTO':
      return i.tipoAtendimento;
    case 'LOJA':
      return i.loja;
    case 'CAMPANHA':
      return i.campanha;
    case 'UTM_SOURCE':
      return i.utmSource;
    case 'SRC':
      return i.src;
    case 'CHECKOUT':
      return i.checkout;
  }
}

export function regraCasa(regra: RegraClassificacaoInput, i: ClassificacaoInput): boolean {
  const atual = searchKey(campoValor(i, regra.campo));
  const alvo = searchKey(regra.valor);
  if (atual === null || alvo === null) return false;
  switch (regra.operador) {
    case 'IGUAL':
      return atual === alvo;
    case 'CONTEM':
      return atual.includes(alvo);
    case 'COMECA_COM':
      return atual.startsWith(alvo);
  }
}

/** Valor da coluna `canal` -> grupo. Comparação sem acento/caixa. */
export function grupoDoCanal(canal: string | null | undefined): TipoGrupo | null {
  switch (searchKey(canal ?? null)) {
    case 'front':
      return 'FRONT';
    case 'call center':
    case 'callcenter':
      return 'CALL_CENTER';
    case 'recuperacao de vendas':
    case 'recuperacao':
      return 'RECUPERACAO';
    case 'back end':
    case 'backend':
    case 'back-end':
      return 'BACKEND_OUTROS';
    case 'afiliado':
      return 'AFILIADO';
    default:
      return null;
  }
}

export function classificar(input: ClassificacaoInput, regras: RegraClassificacaoInput[]): ClassificacaoResultado {
  const tipoVenda = derivarTipoVenda(input.tipoBruto, input.kitNome);

  const doCanal = grupoDoCanal(input.canalPlanilha);
  if (doCanal) {
    return { grupo: doCanal, tipoVenda, motivo: `canal da planilha = ${searchKey(input.canalPlanilha ?? null)}`, regraId: null };
  }

  if (searchKey(input.afiliadoNome) !== null) {
    return { grupo: 'AFILIADO', tipoVenda, motivo: 'campo afiliado preenchido', regraId: null };
  }
  if (searchKey(input.tipoBruto) === 'call center') {
    return { grupo: 'CALL_CENTER', tipoVenda, motivo: 'tipo = call center', regraId: null };
  }

  const ordenadas = [...regras].sort((a, b) => a.prioridade - b.prioridade || a.id.localeCompare(b.id));
  for (const regra of ordenadas) {
    if (regraCasa(regra, input)) {
      return { grupo: regra.grupo, tipoVenda, motivo: `regra ${regra.id} v${regra.versao}`, regraId: regra.id };
    }
  }

  if (tipoVenda === 'FRONT' || tipoVenda === 'UPSELL' || tipoVenda === 'DOWNSELL') {
    return { grupo: 'FRONT', tipoVenda, motivo: `tipo = ${tipoVenda.toLowerCase()}`, regraId: null };
  }
  return { grupo: 'NAO_CLASSIFICADA', tipoVenda, motivo: 'sem critério confiável', regraId: null };
}
