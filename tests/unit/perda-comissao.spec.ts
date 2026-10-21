import { describe, expect, it } from 'vitest';
import { comissaoPorRegra, mesclarComissao } from '../../src/modules/vendas/domain/comissao';
import { calcularPerda, type EventoPerda } from '../../src/modules/vendas/domain/perda';

const d = (s: string) => new Date(s);
const ev = (tipo: 'ESTORNO' | 'CHARGEBACK', quando: string, valor: number | null, key?: string): EventoPerda => ({
  eventKey: key ?? `${tipo}-${quando}-${valor}`, tipo, ocorridoEm: d(quando), valorCentavos: valor,
});

describe('perda (estorno/chargeback) contada uma única vez', () => {
  it('estorno + chargeback integrais do mesmo pedido = UMA perda, "fica o chargeback" (regra Pagah/Elias); datas de ambos preservadas', () => {
    const p = calcularPerda(29700, [ev('ESTORNO', '2026-10-05T12:00:00Z', 29700), ev('CHARGEBACK', '2026-10-20T12:00:00Z', 29700)]);
    expect(p.perdaCentavos).toBe(29700); // não 59400
    expect(p.perdaTipo).toBe('CHARGEBACK'); // atribuída ao chargeback
    expect(p.statusTipo).toBe('CHARGEBACK');
    expect(p.perdaEm?.toISOString()).toBe('2026-10-20T12:00:00.000Z'); // dia em que o aviso do chargeback chegou
    expect(p.estornadoEm).not.toBeNull();
    expect(p.chargebackEm).not.toBeNull();
    expect(p.integral).toBe(true);
  });

  it('estorno e chargeback com 3 segundos de diferença (caso real da Pagah): conta uma vez, como chargeback', () => {
    const p = calcularPerda(29700, [ev('CHARGEBACK', '2026-10-20T12:00:03Z', 29700), ev('ESTORNO', '2026-10-20T12:00:00Z', 29700)]);
    expect(p).toMatchObject({ perdaCentavos: 29700, perdaTipo: 'CHARGEBACK', statusTipo: 'CHARGEBACK' });
  });

  it('chargeback sem data (histórico) usa a data do estorno para posicionar a perda', () => {
    const semData: EventoPerda = { eventKey: 'c', tipo: 'CHARGEBACK', ocorridoEm: null, valorCentavos: null, derivadoDeStatus: true };
    const p = calcularPerda(29700, [ev('ESTORNO', '2026-10-05T12:00:00Z', 29700), semData]);
    expect(p).toMatchObject({ perdaTipo: 'CHARGEBACK' });
    expect(p.perdaEm?.toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  it('eventos repetidos com a mesma chave não duplicam a perda', () => {
    const e = ev('ESTORNO', '2026-10-05T12:00:00Z', 10000, 'k1');
    expect(calcularPerda(29700, [e, { ...e }]).perdaCentavos).toBe(10000);
  });

  it('reembolso parcial: soma dos parciais distintos, pedido não fica integralmente perdido', () => {
    const p = calcularPerda(29700, [ev('ESTORNO', '2026-10-05T12:00:00Z', 10000, 'a'), ev('ESTORNO', '2026-10-06T12:00:00Z', 5000, 'b')]);
    expect(p.perdaCentavos).toBe(15000);
    expect(p.integral).toBe(false);
    expect(p.statusTipo).toBeNull();
  });

  it('parciais nunca excedem o valor da venda', () => {
    const p = calcularPerda(10000, [ev('ESTORNO', '2026-10-05T12:00:00Z', 7000, 'a'), ev('CHARGEBACK', '2026-10-06T12:00:00Z', 7000, 'b')]);
    expect(p.perdaCentavos).toBe(10000);
    expect(p.integral).toBe(true);
  });

  it('evento sem valor: assume integral mas SINALIZA (não esconde a limitação)', () => {
    const p = calcularPerda(29700, [ev('ESTORNO', '2026-10-05T12:00:00Z', null)]);
    expect(p.perdaCentavos).toBe(29700);
    expect(p.avisos.join(' ')).toMatch(/sem valor/);
  });

  it('evento derivado do status do histórico não gera aviso de valor ausente', () => {
    const p = calcularPerda(29700, [{ ...ev('ESTORNO', '2026-10-05T12:00:00Z', null), derivadoDeStatus: true }]);
    expect(p.avisos).toEqual([]);
  });

  it('sem eventos de perda: zero', () => {
    expect(calcularPerda(29700, [])).toMatchObject({ perdaCentavos: 0, perdaEm: null, integral: false });
  });
});

describe('comissão: fonte e substituição', () => {
  it('estimada é substituída por confirmada (mesma venda)', () => {
    const r = mesclarComissao({ centavos: 24000, fonte: 'ESTIMADA' }, { centavos: 18000, fonte: 'PAGAH' });
    expect(r).toEqual({ centavos: 18000, fonte: 'PAGAH' });
  });

  it('histórico exato prevalece sobre Pagah e sobre estimada', () => {
    expect(mesclarComissao({ centavos: 18000, fonte: 'HISTORICO_EXATA' }, { centavos: 17000, fonte: 'PAGAH' }).centavos).toBe(18000);
    expect(mesclarComissao({ centavos: 24000, fonte: 'ESTIMADA' }, { centavos: 18000, fonte: 'HISTORICO_EXATA' }).centavos).toBe(18000);
  });

  it('correção da mesma fonte atualiza o valor', () => {
    expect(mesclarComissao({ centavos: 18000, fonte: 'PAGAH' }, { centavos: 19000, fonte: 'PAGAH' }).centavos).toBe(19000);
  });

  it('ausente (null) nunca apaga; zero explícito é um dado', () => {
    expect(mesclarComissao({ centavos: 18000, fonte: 'PAGAH' }, { centavos: null, fonte: 'AUSENTE' }).centavos).toBe(18000);
    expect(mesclarComissao({ centavos: null, fonte: 'AUSENTE' }, { centavos: 0, fonte: 'PAGAH' })).toEqual({ centavos: 0, fonte: 'PAGAH' });
  });

  it('regra de afiliado respeita vigência e prefere a regra mais recente; sem regra vigente => null (sem R$ 240 universal)', () => {
    const regras = [
      { valorFixoCentavos: 24000, percentualBps: null, vigenteDe: d('2026-01-01T00:00:00Z'), vigenteAte: d('2026-06-01T00:00:00Z') },
      { valorFixoCentavos: null, percentualBps: 1000, vigenteDe: d('2026-06-01T00:00:00Z'), vigenteAte: null },
    ];
    expect(comissaoPorRegra(29700, d('2026-03-10T00:00:00Z'), regras)).toBe(24000);
    expect(comissaoPorRegra(29700, d('2026-10-10T00:00:00Z'), regras)).toBe(2970);
    expect(comissaoPorRegra(29700, d('2025-12-31T00:00:00Z'), regras)).toBeNull();
    expect(comissaoPorRegra(29700, d('2026-10-10T00:00:00Z'), [])).toBeNull();
  });
});
