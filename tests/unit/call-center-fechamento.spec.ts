import { describe, expect, it } from 'vitest';
import { calcularFechamento, competenciaDoAlvo, limitesDoMes, limitesDoPeriodo, valorDaPlanilha, type VendaDoFechamento } from '../../src/modules/call-center/fechamento.domain';

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

  it('venda de outubro revertida só depois do mês AINDA é venda de outubro (posição no fim do mês); a reversão pesa em novembro', () => {
    const out = v({ status: 'CHARGEBACK', perdaEm: d('2026-11-02T10:00:00'), valorVendaCentavos: 12_300 });
    const r = calcularFechamento('2026-10', [out, v({})]);
    expect(r.vendas.pedidos).toBe(2);
    expect(r.avisos.revertidasDepois).toMatchObject({ pedidos: 1 });
    expect(r.avisos.revertidasNoMes.pedidos).toBe(0);
    // e em novembro ela é chargeback de pedido pago antes do mês
    const nov = calcularFechamento('2026-11', [out]);
    expect(nov.vendas.pedidos).toBe(0);
    expect(nov.chargebacks).toEqual({ pedidos: 1, totalCentavos: 12_300 });
  });

  it('reversão sem data conta como já revertida: não entra como venda', () => {
    const r = calcularFechamento('2026-10', [v({ status: 'ESTORNADO', perdaEm: null }), v({})]);
    expect(r.vendas.pedidos).toBe(1);
    expect(r.avisos.revertidasNoMes.pedidos).toBe(1);
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

  it('o chargeback entra pela data do ESTORNO ou do CHARGEBACK, e vale o pedido criado antes do mês (como na aba do dono)', () => {
    const r = calcularFechamento('2026-10', [
      // estorno em setembro e chargeback em 04/10: o dono desconta pela data do chargeback
      v({ status: 'CHARGEBACK', pagoEm: d('2026-09-15T12:00:00'), perdaEm: d('2026-09-29T08:43:00'), reversoesEm: [d('2026-09-29T08:43:00'), d('2026-10-04T07:25:00')], valorVendaCentavos: 39_700 }),
      // criado em setembro, pago em 15/10 e estornado em 16/10: criado antes do mês, então é chargeback e não é venda
      v({ status: 'ESTORNADO', criadoEm: d('2026-09-25T11:35:00'), pagoEm: d('2026-10-15T18:00:00'), perdaEm: d('2026-10-16T06:23:00'), valorVendaCentavos: 37_800 }),
      // criado e revertido dentro do mês: some das duas pontas
      v({ status: 'ESTORNADO', criadoEm: d('2026-10-14T11:35:00'), pagoEm: d('2026-10-15T18:00:00'), perdaEm: d('2026-10-16T06:23:00') }),
    ]);
    expect(r.chargebacks).toEqual({ pedidos: 2, totalCentavos: 39_700 + 37_800 });
    expect(r.vendas.pedidos).toBe(0);
  });

  it('antes de 01/10 a origem com o nome do vendedor não vale: o que o sistema já classificava como Call Center entra no chargeback', () => {
    const r = calcularFechamento('2026-10', [
      v({ status: 'CHARGEBACK', origem: 'Jessica Teste', grupo: 'CALL_CENTER', pagoEm: d('2026-09-28T10:00:00'), perdaEm: d('2026-10-20T10:00:00'), valorVendaCentavos: 29_700 }),
      v({ status: 'CHARGEBACK', origem: 'Jessica Teste', grupo: 'RECUPERACAO', pagoEm: d('2026-09-28T10:00:00'), perdaEm: d('2026-10-20T10:00:00') }),
      // pago em outubro vale só a origem do Pagah: nome de vendedor não é Call
      v({ status: 'CHARGEBACK', origem: 'Jessica Teste', grupo: 'CALL_CENTER', criadoEm: d('2026-09-30T10:00:00'), pagoEm: d('2026-10-02T10:00:00'), perdaEm: d('2026-10-20T10:00:00') }),
    ]);
    expect(r.chargebacks).toEqual({ pedidos: 1, totalCentavos: 29_700 });
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

describe('fechamento por período livre', () => {
  it('o período vai do início do primeiro dia ao início do dia seguinte ao último, em Brasília', () => {
    const l = limitesDoPeriodo('2026-10-10', '2026-10-12');
    expect(l.inicio.toISOString()).toBe('2026-10-10T03:00:00.000Z');
    expect(l.fim.toISOString()).toBe('2026-10-13T03:00:00.000Z');
    expect(limitesDoPeriodo('2026-12-31', '2026-12-31').fim.toISOString()).toBe('2027-01-01T03:00:00.000Z');
    expect(() => limitesDoPeriodo('2026-10-12', '2026-10-10')).toThrow();
    expect(() => limitesDoPeriodo('2026-13-01', '2026-13-02')).toThrow();
  });

  it('chargeback é de pedido pago antes do início do período, qualquer que seja o tamanho dele', () => {
    const r = calcularFechamento({ de: '2026-10-10', ate: '2026-10-12' }, [
      v({ pagoEm: d('2026-10-11T10:00:00') }),
      v({ status: 'CHARGEBACK', pagoEm: d('2026-10-05T10:00:00'), perdaEm: d('2026-10-11T08:00:00'), valorVendaCentavos: 10_000 }),
      v({ status: 'CHARGEBACK', pagoEm: d('2026-10-11T09:00:00'), perdaEm: d('2026-10-11T18:00:00') }), // no próprio período: some
    ]);
    expect(r.mes).toBeNull();
    expect(r.periodo).toEqual({ de: '2026-10-10', ate: '2026-10-12' });
    expect(r.vendas.pedidos).toBe(1);
    expect(r.chargebacks).toEqual({ pedidos: 1, totalCentavos: 10_000 });
    expect(r.avisos.revertidasNoMes.pedidos).toBe(1);
  });
});

describe('posição em (reproduzir um arquivo exportado depois do fim do período)', () => {
  const rev = v({ status: 'CHARGEBACK', pagoEm: d('2026-10-28T10:00:00'), perdaEm: d('2026-11-03T09:00:00') });

  it('por padrão a posição é o fim do período: reversão de novembro não tira a venda de outubro', () => {
    expect(calcularFechamento('2026-10', [rev]).vendas.pedidos).toBe(1);
  });

  it('com a posição no dia da exportação, quem já tinha sido revertido até lá some e quem ainda não, fica', () => {
    const antes = calcularFechamento('2026-10', [rev], d('2026-11-03T00:00:00'));
    expect(antes.vendas.pedidos).toBe(1); // reverteu às 09:00 do dia 3, depois da posição (00:00 do dia 3)
    const depois = calcularFechamento('2026-10', [rev], d('2026-11-04T00:00:00'));
    expect(depois.vendas.pedidos).toBe(0);
    expect(depois.avisos.revertidasNoMes.pedidos).toBe(1);
  });
});

describe('ajustes manuais da competência', () => {
  const setembro = v({ pedido: 'A100', pagoEm: d('2026-09-30T21:23:59'), valorVendaCentavos: 19_700, valorTotalCentavos: 19_700, metodoPagamento: 'Pix' });
  const inc = { pedido: 'A100', acao: 'INCLUIR_VENDA' as const, motivo: 'pago em 30/09 mas o export do Pagah do dono o traz em outubro' };

  it('incluir conta o pedido como venda da competência, com o efeito à vista (e sem ele o pedido de setembro não entra)', () => {
    expect(calcularFechamento('2026-10', [setembro, v({})]).vendas.pedidos).toBe(1);
    const r = calcularFechamento('2026-10', [setembro, v({})], undefined, [inc]);
    expect(r.vendas.pedidos).toBe(2);
    expect(r.vendas.totalCentavos).toBe(39_700 + 19_700);
    expect(r.ajustes).toEqual([{ ...inc, aplicado: true, efeitoCentavos: 19_700 }]);
    expect(r.vendas.porMetodo.find((m) => m.metodo === 'PIX')).toMatchObject({ pedidos: 1, totalCentavos: 19_700 });
  });

  it('excluir tira do mês um pedido que contava, com efeito negativo', () => {
    const r = calcularFechamento('2026-10', [v({ pedido: 'B1' }), v({})], undefined, [{ pedido: 'B1', acao: 'EXCLUIR_VENDA', motivo: 'conferido no Pagah: pago em setembro' }]);
    expect(r.vendas.pedidos).toBe(1);
    expect(r.ajustes[0]).toMatchObject({ aplicado: true, efeitoCentavos: -39_700 });
  });

  it('ajuste sem efeito aparece como não aplicado: pedido já contado, já revertido ou sem origem Call/Whats', () => {
    const natural = v({ pedido: 'N1' });
    const revertido = v({ pedido: 'R1', pagoEm: d('2026-09-30T22:00:00'), status: 'CHARGEBACK', perdaEm: d('2026-10-05T10:00:00') });
    const site = v({ pedido: 'S1', origem: 'Site', pagoEm: d('2026-09-30T22:00:00') });
    const r = calcularFechamento('2026-10', [natural, revertido, site], undefined, [
      { pedido: 'N1', acao: 'INCLUIR_VENDA', motivo: 'já era venda de outubro' },
      { pedido: 'R1', acao: 'INCLUIR_VENDA', motivo: 'foi revertido em outubro' },
      { pedido: 'S1', acao: 'INCLUIR_VENDA', motivo: 'não é Call nem Whats' },
    ]);
    expect(r.vendas.pedidos).toBe(1); // só o natural, uma vez
    expect(r.ajustes.map((a) => [a.pedido, a.aplicado, a.efeitoCentavos])).toEqual([['N1', false, 0], ['R1', false, 0], ['S1', false, 0]]);
  });

  it('a competência é o mês inteiro, pelo mês ou pelo período do dia 1 ao último dia; período livre não recebe ajuste', () => {
    expect(competenciaDoAlvo('2026-10')).toBe('2026-10');
    expect(competenciaDoAlvo({ de: '2026-10-01', ate: '2026-10-31' })).toBe('2026-10');
    expect(competenciaDoAlvo({ de: '2026-02-01', ate: '2026-02-28' })).toBe('2026-02');
    expect(competenciaDoAlvo({ de: '2026-10-05', ate: '2026-10-31' })).toBeNull();
    expect(competenciaDoAlvo({ de: '2026-10-01', ate: '2026-10-30' })).toBeNull();
  });
});
