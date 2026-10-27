import type { TipoEvento } from '../../generated/prisma/client';
import {
  mapFonteComissao,
  mapTipoEvento,
  normalizarMetodo,
  type EventoRow,
  type HistoricoRow,
} from '../../integrations/google-sheets/google-sheets.schemas';
import { eventKey, type Fato } from '../vendas/domain/venda.aggregator';
import { stableHash } from '../../shared/utils/text';
import { searchKey } from '../../shared/utils/text';

export interface FatoPedido {
  pedido: string;
  fato: Fato;
  /** chave do RegistroImportado (idempotência por linha) */
  chaveRegistro: string;
  hashRegistro: string;
  linha: number;
  avisos: string[];
}

export interface FatoErro {
  linha: number;
  codigo: string;
  campo: string | null;
  mensagem: string;
}

export type ResultadoFato = { ok: FatoPedido } | { ignorado: string } | { erro: FatoErro };

/** Status do HISTORICO -> tipo de perda ou pagamento. Status que não são venda concluída são ignorados (não inventados). */
export function mapStatusHistorico(raw: string | null): TipoEvento | null {
  const s = searchKey(raw);
  if (!s) return null;
  if (s.includes('charge')) return 'CHARGEBACK';
  if (s.includes('estorn') || s.includes('reembols') || s.includes('refund')) return 'ESTORNO';
  if (s === 'pago' || s.includes('pago') || s.includes('aprov') || s.includes('paid') || s.includes('conclu')) return 'PAGAMENTO';
  return null;
}

export function eventoParaFato(row: EventoRow, linha: number, valorVendaRef: number | null): ResultadoFato {
  if (row.teste) return { ignorado: 'registro de teste' };
  const tipo = mapTipoEvento(row.evento);
  if (!tipo) return { erro: { linha, codigo: 'EVENTO_DESCONHECIDO', campo: 'evento', mensagem: 'tipo de evento não reconhecido' } };

  const valorVenda = row.valor_sem_juros;
  if (valorVenda === null && tipo === 'PAGAMENTO') {
    return { erro: { linha, codigo: 'VALOR_AUSENTE', campo: 'valor_sem_juros', mensagem: 'pagamento sem valor_sem_juros' } };
  }
  const ocorridoEm = tipo === 'PAGAMENTO' ? (row.pago_em ?? row.recebido_em) : row.recebido_em;
  const avisos: string[] = [];
  const { fonte, reconhecida } = mapFonteComissao(row.comissao_fonte);
  if (row.comissao !== null && !reconhecida) avisos.push('fonte da comissão não reconhecida: tratada como estimada');

  const hash = stableHash(row as unknown as Record<string, unknown>);
  const key = eventKey(row.pedido, tipo, valorVenda, valorVendaRef ?? valorVenda);

  return {
    ok: {
      pedido: row.pedido,
      linha,
      avisos,
      chaveRegistro: key,
      hashRegistro: hash,
      fato: {
        fonte: 'EVENTOS',
        atributos: {
          loja: row.loja,
          produto: row.produto,
          afiliadoNome: row.afiliado,
          tipoBruto: row.tipo,
          checkout: row.checkout,
          metodo: normalizarMetodo(row.metodo),
          vendedorId: row.payload.vendedorId,
          // a taxa do pedido é a do evento de PAGAMENTO; nos eventos de perda o valor é o da reversão e não a define
          taxaCallCenterCentavos: tipo === 'PAGAMENTO' ? row.payload.taxaCallCenterCentavos : null,
          clienteHash: row.cliente_id,
          canalPlanilha: row.canal,
          subcanal: row.subcanal,
          origemLead: row.origem_lead,
          parcelas: row.parcelas,
          utmSource: row.utm_source,
          utmCampaign: row.utm_campaign,
          utmContent: row.utm_content,
          src: row.src,
          valorTotalCentavos: row.valor_total,
          valorVendaCentavos: valorVenda,
          valorLiquidoCentavos: row.valor_liquido,
          pagoEm: row.pago_em,
        },
        comissao: row.comissao === null ? { centavos: null, fonte: 'AUSENTE' } : { centavos: row.comissao, fonte: fonte },
        eventos: [
          {
            eventKey: key,
            tipo,
            fonte: 'EVENTOS',
            ocorridoEm,
            recebidoEm: row.recebido_em,
            valorCentavos: valorVenda,
            comissaoCentavos: row.comissao,
            linhaOrigem: linha,
            hashConteudo: hash,
          },
        ],
      },
    },
  };
}

export function historicoParaFato(row: HistoricoRow, linha: number): ResultadoFato {
  const tipoStatus = mapStatusHistorico(row.status);
  if (!tipoStatus) return { ignorado: 'status não corresponde a venda concluída' };
  const hash = stableHash(row as unknown as Record<string, unknown>);
  const eventos: Fato['eventos'] = [];
  const avisos: string[] = [];

  // valor_sem_juros vazio: só é derivado quando a conta é exata, isto é, valor_total E juros estão presentes
  // (juros = 0 explícito é um dado). Juros vazio NÃO autoriza usar valor_total no lugar.
  let valorSemJuros = row.valor_sem_juros;
  if (valorSemJuros === null && row.valor_total !== null && row.juros !== null && row.juros >= 0 && row.valor_total >= row.juros) {
    valorSemJuros = row.valor_total - row.juros;
    avisos.push('valor_sem_juros derivado de valor_total − juros');
  }
  if (valorSemJuros === null) {
    return { erro: { linha, codigo: 'VALOR_AUSENTE', campo: 'valor_sem_juros', mensagem: 'linha sem valor_sem_juros' } };
  }

  if (row.data_pagamento) {
    eventos.push({
      eventKey: eventKey(row.pedido, 'PAGAMENTO', valorSemJuros, valorSemJuros),
      tipo: 'PAGAMENTO',
      fonte: 'HISTORICO',
      ocorridoEm: row.data_pagamento,
      recebidoEm: null,
      valorCentavos: valorSemJuros,
      comissaoCentavos: row.comissao,
      linhaOrigem: linha,
      hashConteudo: hash,
    });
  }
  if (tipoStatus !== 'PAGAMENTO') {
    // O histórico guarda só o status ATUAL: gera apenas o evento de perda, sem fabricar o pagamento original.
    eventos.push({
      eventKey: eventKey(row.pedido, tipoStatus, null, valorSemJuros),
      tipo: tipoStatus,
      fonte: 'HISTORICO',
      ocorridoEm: row.data_estorno,
      recebidoEm: null,
      valorCentavos: null,
      comissaoCentavos: null,
      linhaOrigem: linha,
      hashConteudo: hash,
      derivadoDeStatus: true,
    });
    if (!row.data_estorno) avisos.push('histórico sem data de estorno');
  }

  return {
    ok: {
      pedido: row.pedido,
      linha,
      avisos,
      chaveRegistro: row.pedido,
      hashRegistro: hash,
      fato: {
        fonte: 'HISTORICO',
        atributos: {
          loja: row.loja,
          produto: row.produto,
          afiliadoNome: row.afiliado,
          tipoBruto: row.tipo,
          origem: row.origem,
          tipoAtendimento: row.tipo_atendimento,
          atendente: row.atendente,
          metodo: normalizarMetodo(row.metodo),
          comissaoAfiliadoCentavos: row.comissao_afiliado,
          campanha: row.campanha,
          clickId: row.click_id,
          valorTotalCentavos: row.valor_total,
          valorVendaCentavos: valorSemJuros,
          jurosCentavos: row.juros,
          taxaCallCenterCentavos: row.taxa_call_center,
          pagoEm: row.data_pagamento,
          criadoEmOrigem: row.data_criacao,
        },
        comissao: row.comissao === null ? { centavos: null, fonte: 'AUSENTE' } : { centavos: row.comissao, fonte: 'HISTORICO_EXATA' },
        eventos,
      },
    },
  };
}
