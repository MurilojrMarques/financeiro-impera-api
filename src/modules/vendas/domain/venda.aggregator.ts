import type { FonteDadoTipo, StatusVenda, TipoEvento } from '../../../generated/prisma/client';
import { mesclarComissao, type ComissaoValor } from './comissao';
import { calcularPerda, type EventoPerda, type PerdaCalculada } from './perda';

export interface Atributos {
  loja: string | null;
  produto: string | null; // nome do kit/produto
  afiliadoNome: string | null;
  tipoBruto: string | null;
  origem: string | null;
  tipoAtendimento: string | null;
  atendente: string | null;
  checkout: string | null;
  metodo: string | null;
  campanha: string | null;
  anuncio: string | null;
  clickId: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  src: string | null;
  parcelas: number | null;
  valorTotalCentavos: number | null;
  valorVendaCentavos: number | null;
  jurosCentavos: number | null;
  valorLiquidoCentavos: number | null;
  taxaCallCenterCentavos: number | null;
  /** comissão do AFILIADO informada pela fonte (HISTORICO); regra configurada é aplicada na persistência */
  comissaoAfiliadoCentavos: number | null;
  vendedorId: string | null;
  clienteHash: string | null;
  canalPlanilha: string | null;
  subcanal: string | null;
  origemLead: string | null;
  pagoEm: Date | null;
  criadoEmOrigem: Date | null;
}

export const ATRIBUTOS_VAZIOS: Atributos = {
  loja: null, produto: null, afiliadoNome: null, tipoBruto: null, origem: null, tipoAtendimento: null,
  atendente: null, checkout: null, metodo: null, campanha: null, anuncio: null, clickId: null,
  utmSource: null, utmCampaign: null, utmContent: null, src: null, parcelas: null,
  valorTotalCentavos: null, valorVendaCentavos: null, jurosCentavos: null, valorLiquidoCentavos: null,
  taxaCallCenterCentavos: null, comissaoAfiliadoCentavos: null, vendedorId: null, clienteHash: null, canalPlanilha: null, subcanal: null, origemLead: null, pagoEm: null, criadoEmOrigem: null,
};

export interface EventoFato {
  eventKey: string;
  tipo: TipoEvento;
  fonte: FonteDadoTipo;
  ocorridoEm: Date | null;
  recebidoEm: Date | null;
  valorCentavos: number | null;
  comissaoCentavos: number | null;
  linhaOrigem: number | null;
  hashConteudo: string;
  derivadoDeStatus?: boolean;
}

export interface Fato {
  fonte: 'HISTORICO' | 'EVENTOS';
  atributos: Partial<Atributos>;
  comissao: ComissaoValor;
  eventos: EventoFato[];
}

export interface EstadoVenda {
  atributos: Atributos;
  comissao: ComissaoValor;
  fonteVerdade: FonteDadoTipo | null;
  eventos: EventoFato[];
}

export interface ResultadoVenda {
  atributos: Atributos;
  comissao: ComissaoValor;
  fonteVerdade: FonteDadoTipo;
  eventos: EventoFato[];
  perda: PerdaCalculada;
  status: StatusVenda;
  avisos: string[];
}

const PROTEGIDOS_EM_PERDA = new Set<keyof Atributos>([
  'pagoEm', 'valorTotalCentavos', 'valorVendaCentavos', 'valorLiquidoCentavos', 'jurosCentavos',
]);

/** Chave determinística de evento (ver docs/IDENTIDADE.md). Não depende de linha nem de horário de recebimento. */
export function eventKey(pedido: string, tipo: TipoEvento, valorEvento: number | null, valorVenda: number | null): string {
  if (tipo === 'PAGAMENTO') return `${pedido}|PAGAMENTO`;
  const integral = valorEvento === null || valorVenda === null || valorEvento >= valorVenda;
  return `${pedido}|${tipo}|${integral ? 'INTEGRAL' : valorEvento}`;
}

/**
 * Mescla fatos (de HISTORICO e/ou EVENTOS) ao estado atual do pedido.
 *  - HISTORICO é a fonte de verdade para atributos descritivos: sobrescreve.
 *  - EVENTOS só preenche lacunas quando o pedido já tem origem HISTORICO; sobre EVENTOS, o mais recente prevalece (correções).
 *  - Valores nulos recebidos nunca apagam dados existentes (ausente ≠ zero; zero explícito é preservado).
 *  - Eventos são unidos por eventKey (idempotente); perda calculada uma única vez.
 */
export function aplicarFatos(estado: EstadoVenda | null, fatos: Fato[]): ResultadoVenda {
  const atributos: Atributos = { ...(estado?.atributos ?? ATRIBUTOS_VAZIOS) };
  let comissao: ComissaoValor = estado?.comissao ?? { centavos: null, fonte: 'AUSENTE' };
  let fonteVerdade: FonteDadoTipo = estado?.fonteVerdade ?? 'EVENTOS';
  const eventos = new Map<string, EventoFato>((estado?.eventos ?? []).map((e) => [e.eventKey, e]));

  for (const fato of fatos) {
    const historicoManda = fonteVerdade === 'HISTORICO' && fato.fonte === 'EVENTOS';
    // Evento de estorno/chargeback não redefine a data de pagamento nem o valor da venda já conhecidos:
    // o valor desse evento pode ser o valor REEMBOLSADO (parcial), não o da venda. Só PAGAMENTO/HISTORICO os definem.
    const soPerdas = fato.fonte === 'EVENTOS' && fato.eventos.length > 0 && fato.eventos.every((e) => e.tipo !== 'PAGAMENTO');
    for (const [k, v] of Object.entries(fato.atributos) as [keyof Atributos, unknown][]) {
      if (v === null || v === undefined) continue;
      if (historicoManda && atributos[k] !== null) continue;
      if (soPerdas && PROTEGIDOS_EM_PERDA.has(k) && atributos[k] !== null) continue;
      (atributos as unknown as Record<string, unknown>)[k] = v;
    }
    if (fato.fonte === 'HISTORICO') fonteVerdade = 'HISTORICO';
    comissao = mesclarComissao(comissao, fato.comissao);
    for (const ev of fato.eventos) {
      const atual = eventos.get(ev.eventKey);
      if (atual?.fonte === 'HISTORICO' && ev.fonte === 'EVENTOS') {
        // mesmo evento nas duas fontes: HISTORICO manda; EVENTOS só completa lacunas
        eventos.set(ev.eventKey, {
          ...atual,
          ocorridoEm: atual.ocorridoEm ?? ev.ocorridoEm,
          recebidoEm: atual.recebidoEm ?? ev.recebidoEm,
          valorCentavos: atual.valorCentavos ?? ev.valorCentavos,
          derivadoDeStatus: atual.derivadoDeStatus && ev.valorCentavos === null,
        });
      } else {
        eventos.set(ev.eventKey, ev);
      }
    }
  }

  const valorVenda = atributos.valorVendaCentavos ?? 0;
  const perdas: EventoPerda[] = [...eventos.values()]
    .filter((e): e is EventoFato & { tipo: 'ESTORNO' | 'CHARGEBACK' } => e.tipo !== 'PAGAMENTO')
    .map((e) => ({
      eventKey: e.eventKey,
      tipo: e.tipo,
      ocorridoEm: e.ocorridoEm,
      valorCentavos: e.valorCentavos,
      derivadoDeStatus: e.derivadoDeStatus,
    }));
  const perda = calcularPerda(valorVenda, perdas);

  const avisos = [...perda.avisos];
  let status: StatusVenda;
  if (atributos.pagoEm === null) {
    status = 'PENDENTE_CONCILIACAO';
    avisos.push('data de pagamento ausente: pedido fora das visões por data de pagamento');
  } else if (perda.integral && perda.statusTipo) {
    status = perda.statusTipo === 'CHARGEBACK' ? 'CHARGEBACK' : 'ESTORNADO';
  } else {
    status = 'PAGO';
  }

  return { atributos, comissao, fonteVerdade, eventos: [...eventos.values()], perda, status, avisos };
}
