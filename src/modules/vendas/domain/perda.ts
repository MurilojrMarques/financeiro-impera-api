import type { TipoEvento } from '../../../generated/prisma/client';

export type TipoPerda = Exclude<TipoEvento, 'PAGAMENTO'>;

export interface EventoPerda {
  eventKey: string;
  tipo: TipoPerda;
  ocorridoEm: Date | null;
  valorCentavos: number | null;
  /** Evento derivado do status do HISTORICO (expressa perda integral; não gera aviso de valor ausente). */
  derivadoDeStatus?: boolean;
}

export interface PerdaCalculada {
  perdaCentavos: number;
  /** Data do evento que estabeleceu a perda (o mais antigo). */
  perdaEm: Date | null;
  /** Tipo do evento mais antigo — é a ele que a perda é atribuída nos relatórios. */
  perdaTipo: TipoPerda | null;
  /** Tipo do evento integral mais recente — define o status atual do pedido. */
  statusTipo: TipoPerda | null;
  estornadoEm: Date | null;
  chargebackEm: Date | null;
  integral: boolean;
  avisos: string[];
}

const time = (e: EventoPerda) => e.ocorridoEm?.getTime() ?? Infinity;

/**
 * Perda financeira de um pedido, contada UMA vez.
 *  - Evento sem valor, ou com valor >= valor da venda, é perda INTEGRAL.
 *    Estorno + chargeback integrais do mesmo pedido = uma única perda, atribuída ao CHARGEBACK e à data dele
 *    (ambos os eventos preservados para auditoria).
 *  - Somente eventos parciais: soma dos eventos distintos (por eventKey), limitada ao valor da venda.
 *  - Nunca cria valores: evento sem valor é tratado como integral e SINALIZADO em `avisos`.
 */
export function calcularPerda(valorVendaCentavos: number, eventos: EventoPerda[]): PerdaCalculada {
  const vistos = new Map<string, EventoPerda>();
  for (const e of eventos) vistos.set(e.eventKey, e);
  const unicos = [...vistos.values()].sort((a, b) => time(a) - time(b));

  const estornadoEm = unicos.find((e) => e.tipo === 'ESTORNO' && e.ocorridoEm)?.ocorridoEm ?? null;
  const chargebackEm = unicos.find((e) => e.tipo === 'CHARGEBACK' && e.ocorridoEm)?.ocorridoEm ?? null;

  if (unicos.length === 0) {
    return { perdaCentavos: 0, perdaEm: null, perdaTipo: null, statusTipo: null, estornadoEm, chargebackEm, integral: false, avisos: [] };
  }

  const avisos: string[] = [];
  if (unicos.some((e) => e.valorCentavos === null && !e.derivadoDeStatus)) {
    avisos.push('evento de perda sem valor informado: assumida perda integral');
  }
  if (unicos.some((e) => e.ocorridoEm === null)) {
    avisos.push('evento de perda sem data: perda não entra na visão de movimentação por data');
  }

  const isIntegral = (e: EventoPerda) => e.valorCentavos === null || e.valorCentavos >= valorVendaCentavos;
  const integrais = unicos.filter(isIntegral);
  if (integrais.length > 0) {
    // Regra do negócio (doc Pagah 16/10): estorno + chargeback do mesmo pedido contam UMA vez e "fica o chargeback"
    // (a Pagah às vezes manda os dois com segundos de diferença). Data = a do chargeback; sem data nele, a do estorno.
    const ref = integrais.find((e) => e.tipo === 'CHARGEBACK') ?? integrais[0];
    return {
      perdaCentavos: valorVendaCentavos,
      perdaEm: ref.ocorridoEm ?? integrais.find((e) => e.ocorridoEm)?.ocorridoEm ?? null,
      perdaTipo: ref.tipo,
      statusTipo: ref.tipo,
      estornadoEm,
      chargebackEm,
      integral: true,
      avisos,
    };
  }

  const soma = unicos.reduce((acc, e) => acc + (e.valorCentavos ?? 0), 0);
  const perda = Math.min(soma, valorVendaCentavos);
  const integral = perda >= valorVendaCentavos;
  return {
    perdaCentavos: perda,
    perdaEm: unicos[0].ocorridoEm,
    perdaTipo: unicos[0].tipo,
    statusTipo: integral ? unicos[unicos.length - 1].tipo : null,
    estornadoEm,
    chargebackEm,
    integral,
    avisos,
  };
}
