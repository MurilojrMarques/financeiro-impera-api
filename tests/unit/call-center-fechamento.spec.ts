import { describe, expect, it } from 'vitest';
import { calcularFechamento, limitesDoMes, valorDaPlanilha, type VendaDoFechamento } from '../../src/modules/call-center/fechamento.domain';

/**
 * O fechamento do Call Center na fórmula da planilha do dono (outubro/2026), com casos que ele mesmo mostrou:
 * origem "Call"/"Whats" só (vendedor com nome e "CALL" em maiúsculas ficam de fora), cartão no valor sem juros,
 * boleto e pix no total, quem foi revertido no próprio mês some, e chargeback é de pedido pago antes do mês.
 */
const d = (s: string) => new Date(`${s}-03:00`);
let n = 0;
const v = (o: Partial<VendaDoFechamento>): VendaDoFechamento => ({
  pedido: String(++n), origem: 'Call', status: 'PAGO', metodoPagamento: 'Cartão', parcelas: 1,
  pagoEm: d('2026-10-15T12:00:00'), perdaEm: null, valorVendaCentavos: 39_700, valorTotalCentavos: 47_832, jurosCentavos: null, ...o,
});

describe('fechamento do Call Center (fórmula da planilha do dono)', () => {
  it('o mês vai de 01 00:00 a 01 00:00 do mês seguinte, em Brasília', () => {
    const l = limitesDoMes('2026-10');
    expect(l.inicio.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(l.fim.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect([l.de, l.ate]).toEqual(['2026-10-01', '2026-10-31']);
    expect(limitesDoMes('2026-12').fim.toISOString()).toBe('2027-01-01T03:00:00.000Z');
    expect(() => limitesDoMes('2026-13')).toThrow();
  });

  it('cartão soma o valor sem juros; boleto e pix somam o total do pedido (colunas J e I da planilha)', () => {
    expect(valorDaPlanilha(v({ metodoPagamento: 'Cartão' }))).toBe(39_700);
    expect(valorDaPlanilha(v({ metodoPagamento: 'Pix', valorTotalCentavos: 29_800, valorVendaCentavos: 29_000 }))).toBe(29_800);
    expect(valorDaPlanilha(v({ metodoPagamento: 'Boleto', valorTotalCentavos: null }))).toBe(39_700);
  });

  it('só entra origem que contém "Call" ou "Whats": nome de vendedor, Site e "CALL" em maiúsculas ficam de fora', () => {
    const r = calcularFechamento('2026-10', [
      v({ origem: 'Call' }), v({ origem: 'Whats' }),
      v({ origem: 'Jessica Teste' }), v({ origem: 'Site' }), v({ origem: 'Jeferson CALL (800K)' }), v({ origem: 'Pedro Carvalho' }),
    ]);
    expect(r.vendas.pedidos).toBe(2);
    expect(r.vendas.totalCentavos).toBe(2 * 39_700);
  });

  it('comissão de 20% sobre as vendas, por método', () => {
    const r = calcularFechamento('2026-10', [
      v({}), v({ metodoPagamento: 'Pix', valorTotalCentavos: 12_345, valorVendaCentavos: 12_345 }), v({ metodoPagamento: 'Boleto', valorTotalCentavos: 22_275 }),
    ]);
    expect(r.vendas.porMetodo.map((m) => [m.metodo, m.pedidos, m.totalCentavos])).toEqual([
      ['CARTAO', 1, 39_700], ['BOLETO', 1, 22_275], ['PIX', 1, 12_345],
    ]);
    expect(r.comissao.percentual).toBe(0.2);
    expect(r.comissao.vendasCentavos).toBe(Math.round(39_700 * 0.2) + Math.round(22_275 * 0.2) + Math.round(12_345 * 0.2));
  });

  it('fora do mês não entra, nem o dia 31 às 23:59 de Brasília para o mês seguinte', () => {
    const r = calcularFechamento('2026-10', [
      v({ pagoEm: d('2026-10-31T23:59:59') }), v({ pagoEm: d('2026-11-01T00:00:00') }), v({ pagoEm: d('2026-09-30T23:59:59') }), v({ pagoEm: d('2026-10-01T00:00:00') }),
    ]);
    expect(r.vendas.pedidos).toBe(2);
  });

  it('venda de outubro revertida em outubro some das duas pontas, como na planilha (e fica nos avisos)', () => {
    const r = calcularFechamento('2026-10', [
      v({ status: 'ESTORNADO', perdaEm: d('2026-10-20T10:00:00') }),
      v({ status: 'CHARGEBACK', perdaEm: d('2026-10-28T10:00:00'), valorVendaCentavos: 10_000 }),
      v({}),
    ]);
    expect(r.vendas.pedidos).toBe(1);
    expect(r.chargebacks.pedidos).toBe(0);
    expect(r.avisos.revertidasNoMes).toMatchObject({ pedidos: 2 });
  });

  it('venda de outubro revertida só depois do mês não entra agora e fica nos avisos', () => {
    const r = calcularFechamento('2026-10', [v({ status: 'CHARGEBACK', perdaEm: d('2026-11-02T10:00:00') }), v({})]);
    expect(r.vendas.pedidos).toBe(1);
    expect(r.avisos.revertidasDepois.pedidos).toBe(1);
  });

  it('chargeback é de pedido pago antes do mês e revertido dentro dele, a 20%', () => {
    const r = calcularFechamento('2026-10', [
      v({ status: 'CHARGEBACK', pagoEm: d('2026-09-30T23:05:00'), perdaEm: d('2026-10-31T06:25:00'), valorVendaCentavos: 39_700 }),
      v({ status: 'ESTORNADO', pagoEm: d('2026-09-10T10:00:00'), perdaEm: d('2026-10-02T12:55:00'), valorVendaCentavos: 23_736 }),
      v({ status: 'CHARGEBACK', pagoEm: d('2026-09-10T10:00:00'), perdaEm: d('2026-11-03T12:00:00') }), // reversão de novembro
      v({ status: 'CHARGEBACK', pagoEm: d('2026-09-10T10:00:00'), perdaEm: d('2026-10-09T06:19:00'), origem: 'Site' }), // não é call
    ]);
    expect(r.chargebacks).toEqual({ pedidos: 2, totalCentavos: 39_700 + 23_736 });
    expect(r.comissao.descontoChargebackCentavos).toBe(Math.round((39_700 + 23_736) * 0.2));
    expect(r.comissao.liquidaCentavos).toBe(r.comissao.vendasCentavos - r.comissao.descontoChargebackCentavos);
  });

  it('pedido sem origem do Pagah não entra e é contado à parte, nunca somado por adivinhação', () => {
    const r = calcularFechamento('2026-10', [
      v({ origem: null }), v({ origem: '  ' }), v({}),
      v({ origem: null, status: 'CHARGEBACK', pagoEm: d('2026-09-01T10:00:00'), perdaEm: d('2026-10-03T10:00:00') }),
    ]);
    expect(r.vendas.pedidos).toBe(1);
    expect(r.avisos.semOrigem.pedidos).toBe(2);
    expect(r.avisos.chargebacksSemOrigem.pedidos).toBe(1);
  });

  it('avisa quando o chargeback de cartão parcelado tem valor sem juros igual ao total (juros provavelmente dentro)', () => {
    const r = calcularFechamento('2026-10', [
      v({ status: 'ESTORNADO', pagoEm: d('2026-08-30T10:00:00'), perdaEm: d('2026-10-14T10:00:00'), parcelas: 12, valorVendaCentavos: 35_988, valorTotalCentavos: 35_988 }),
      v({ status: 'ESTORNADO', pagoEm: d('2026-08-30T10:00:00'), perdaEm: d('2026-10-14T10:00:00'), parcelas: 12, valorVendaCentavos: 29_870, valorTotalCentavos: 35_988 }),
    ]);
    expect(r.avisos.possivelJurosNosChargebacks).toEqual({ pedidos: 1, totalCentavos: 35_988 });
  });
});
