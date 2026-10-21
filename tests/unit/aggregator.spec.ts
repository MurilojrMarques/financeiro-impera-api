import { describe, expect, it } from 'vitest';
import type { EventoRow, HistoricoRow } from '../../src/integrations/google-sheets/google-sheets.schemas';
import { eventoParaFato, historicoParaFato, type FatoPedido } from '../../src/modules/sincronizacao/fatos';
import { aplicarFatos, eventKey, type ResultadoVenda } from '../../src/modules/vendas/domain/venda.aggregator';

const dt = (s: string) => new Date(s);

const eventoBase: EventoRow = {
  pedido: '1001', evento: 'pagamento', recebido_em: dt('2026-10-05T13:00:00Z'), pago_em: dt('2026-10-05T13:00:00Z'),
  tipo: 'front', cliente_id: null, canal: null, subcanal: null, origem_lead: null, afiliado: null, loja: 'Loja A', checkout: 'ck1', produto: 'Kit 3', valor_total: 31000, valor_sem_juros: 29700,
  valor_liquido: null, comissao: 18000, comissao_fonte: 'estimada', metodo: 'cartao', parcelas: 3, utm_source: null,
  utm_campaign: null, utm_content: null, src: null, teste: false, payload: { vendedorId: null },
};
const histBase: HistoricoRow = {
  pedido: '1001', status: 'Pago', data_criacao: dt('2026-10-05T12:50:00Z'), data_pagamento: dt('2026-10-05T13:00:00Z'), data_estorno: null,
  tipo: 'front', origem: 'Site', tipo_atendimento: null, atendente: null, loja: 'Loja A', produto: 'Kit 3', metodo: 'cartao',
  valor_total: 31000, valor_sem_juros: 29700, juros: 1300, comissao: 17500, taxa_call_center: null, comissao_afiliado: null, campanha: 'camp1', click_id: 'c1', afiliado: null,
};

const ok = (r: ReturnType<typeof eventoParaFato>): FatoPedido => {
  if (!('ok' in r)) throw new Error('esperava fato válido');
  return r.ok;
};

function aplicar(...fatos: FatoPedido[]): ResultadoVenda {
  return aplicarFatos(null, fatos.map((f) => f.fato));
}

describe('conversão de linhas em fatos', () => {
  it('registro de teste é ignorado', () => {
    expect(eventoParaFato({ ...eventoBase, teste: true }, 2, null)).toEqual({ ignorado: 'registro de teste' });
  });

  it('evento desconhecido gera erro, nunca vira pagamento por padrão', () => {
    const r = eventoParaFato({ ...eventoBase, evento: 'carrinho_abandonado' }, 2, null);
    expect('erro' in r && r.erro.codigo).toBe('EVENTO_DESCONHECIDO');
  });

  it('pagamento sem valor_sem_juros é erro (não usa valor_total como substituto)', () => {
    const r = eventoParaFato({ ...eventoBase, valor_sem_juros: null }, 2, null);
    expect('erro' in r && r.erro.codigo).toBe('VALOR_AUSENTE');
  });

  it('status do histórico que não é venda concluída é ignorado', () => {
    expect(historicoParaFato({ ...histBase, status: 'Aguardando pagamento' }, 2)).toEqual({ ignorado: expect.any(String) });
  });

  it('histórico sem valor_sem_juros: deriva de valor_total − juros SÓ quando juros está presente (0 explícito); juros vazio continua erro', () => {
    const semVs = { ...histBase, valor_sem_juros: null, valor_total: 29700 };
    const derivado = ok(historicoParaFato({ ...semVs, juros: 0 }, 2));
    expect(aplicar(derivado).atributos.valorVendaCentavos).toBe(29700);
    expect(derivado.avisos.join(' ')).toMatch(/derivado/);
    expect(aplicar(ok(historicoParaFato({ ...semVs, valor_total: 31000, juros: 1300 }, 2))).atributos.valorVendaCentavos).toBe(29700);
    const semJuros = historicoParaFato({ ...semVs, juros: null }, 2);
    expect('erro' in semJuros && semJuros.erro.codigo).toBe('VALOR_AUSENTE'); // nunca usa valor_total "no escuro"
  });

  it('chave do evento é independente de linha e horário de recebimento (reenvio não duplica)', () => {
    const a = ok(eventoParaFato(eventoBase, 5, null));
    const b = ok(eventoParaFato({ ...eventoBase, recebido_em: dt('2026-10-06T00:00:00Z') }, 900, null));
    expect(a.chaveRegistro).toBe(b.chaveRegistro);
    expect(eventKey('1001', 'PAGAMENTO', 1, 1)).toBe('1001|PAGAMENTO');
  });
});

describe('agregação de venda', () => {
  it('valor da venda é valor_sem_juros, não valor_total', () => {
    const r = aplicar(ok(eventoParaFato(eventoBase, 2, null)));
    expect(r.atributos.valorVendaCentavos).toBe(29700);
    expect(r.atributos.valorTotalCentavos).toBe(31000);
  });

  it('mesmo pedido em HISTORICO e EVENTOS: uma venda, um evento de pagamento; histórico manda na comissão exata', () => {
    const r = aplicar(ok(eventoParaFato(eventoBase, 2, null)), ok(historicoParaFato(histBase, 2)));
    expect(r.eventos.filter((e) => e.tipo === 'PAGAMENTO')).toHaveLength(1);
    expect(r.comissao).toEqual({ centavos: 17500, fonte: 'HISTORICO_EXATA' });
    expect(r.fonteVerdade).toBe('HISTORICO');
    expect(r.atributos.campanha).toBe('camp1');
    expect(r.status).toBe('PAGO');
  });

  it('ordem inversa (histórico antes, eventos depois) dá o mesmo resultado e EVENTOS não sobrescreve o histórico', () => {
    const a = aplicar(ok(historicoParaFato(histBase, 2)), ok(eventoParaFato({ ...eventoBase, comissao: 99999, loja: 'Outra' }, 2, null)));
    expect(a.comissao.centavos).toBe(17500);
    expect(a.atributos.loja).toBe('Loja A');
  });

  it('comissão estimada (EVENTOS) é substituída por confirmada (PAGAH) na mesma venda', () => {
    const est = aplicar(ok(eventoParaFato(eventoBase, 2, null)));
    expect(est.comissao.fonte).toBe('ESTIMADA');
    const corrigido = aplicarFatos(
      { atributos: est.atributos, comissao: est.comissao, fonteVerdade: est.fonteVerdade, eventos: est.eventos },
      [ok(eventoParaFato({ ...eventoBase, comissao: 16000, comissao_fonte: 'pagah' }, 3, null)).fato],
    );
    expect(corrigido.comissao).toEqual({ centavos: 16000, fonte: 'PAGAH' });
  });

  it('histórico estornado sem evento de pagamento anterior: só o evento de perda (sem pagamento fabricado, sem desconto em dobro)', () => {
    const r = aplicar(ok(historicoParaFato({ ...histBase, status: 'Estornado', data_pagamento: null, data_estorno: dt('2026-10-10T15:00:00Z') }, 2)));
    expect(r.eventos.map((e) => e.tipo)).toEqual(['ESTORNO']);
    expect(r.perda.perdaCentavos).toBe(29700);
    expect(r.status).toBe('PENDENTE_CONCILIACAO'); // sem data de pagamento: sinalizado, não presumido
    expect(r.avisos.join(' ')).toMatch(/data de pagamento ausente/);
  });

  it('histórico estornado COM data de pagamento: pagamento + estorno, perda contada uma vez', () => {
    const r = aplicar(ok(historicoParaFato({ ...histBase, status: 'Estornado', data_estorno: dt('2026-10-10T15:00:00Z') }, 2)));
    expect(r.eventos.map((e) => e.tipo).sort()).toEqual(['ESTORNO', 'PAGAMENTO']);
    expect(r.perda.perdaCentavos).toBe(29700);
    expect(r.status).toBe('ESTORNADO');
  });

  it('estorno de EVENTOS + estorno de HISTORICO do mesmo pedido colapsam em um único evento', () => {
    const hist = ok(historicoParaFato({ ...histBase, status: 'Estornado', data_estorno: dt('2026-10-10T15:00:00Z') }, 2));
    const evt = ok(eventoParaFato({ ...eventoBase, evento: 'estorno', recebido_em: dt('2026-10-10T15:05:00Z') }, 7, null));
    const r = aplicar(hist, evt);
    expect(r.eventos.filter((e) => e.tipo === 'ESTORNO')).toHaveLength(1);
    expect(r.perda.perdaCentavos).toBe(29700);
  });

  it('estorno e chargeback do mesmo pedido: dois eventos preservados, uma perda; status = mais recente', () => {
    const r = aplicar(
      ok(eventoParaFato(eventoBase, 2, null)),
      ok(eventoParaFato({ ...eventoBase, evento: 'estorno', recebido_em: dt('2026-10-10T10:00:00Z') }, 3, null)),
      ok(eventoParaFato({ ...eventoBase, evento: 'chargeback', recebido_em: dt('2026-10-25T10:00:00Z') }, 4, null)),
    );
    expect(r.eventos).toHaveLength(3);
    expect(r.perda.perdaCentavos).toBe(29700);
    expect(r.perda.perdaTipo).toBe('CHARGEBACK');
    expect(r.status).toBe('CHARGEBACK');
  });

  it('reembolso parcial vindo de EVENTOS (valor menor que a venda) mantém status PAGO com perda parcial', () => {
    const r = aplicar(
      ok(eventoParaFato(eventoBase, 2, null)),
      ok(eventoParaFato({ ...eventoBase, evento: 'estorno', valor_sem_juros: 10000, recebido_em: dt('2026-10-10T10:00:00Z') }, 3, 29700)),
    );
    expect(r.perda.perdaCentavos).toBe(10000);
    expect(r.status).toBe('PAGO');
  });

  it('comissão zero explícita é preservada e diferente de ausente', () => {
    const r = aplicar(ok(eventoParaFato({ ...eventoBase, comissao: 0, comissao_fonte: 'pagah' }, 2, null)));
    expect(r.comissao).toEqual({ centavos: 0, fonte: 'PAGAH' });
    const sem = aplicar(ok(eventoParaFato({ ...eventoBase, comissao: null }, 2, null)));
    expect(sem.comissao.centavos).toBeNull();
  });

  it('idempotência: aplicar os mesmos fatos duas vezes não muda o resultado', () => {
    const fatos = [ok(historicoParaFato(histBase, 2)), ok(eventoParaFato(eventoBase, 2, null))];
    const uma = aplicar(...fatos);
    const duas = aplicarFatos({ atributos: uma.atributos, comissao: uma.comissao, fonteVerdade: uma.fonteVerdade, eventos: uma.eventos }, fatos.map((f) => f.fato));
    expect(duas.eventos).toHaveLength(uma.eventos.length);
    expect(duas.comissao).toEqual(uma.comissao);
    expect(duas.perda.perdaCentavos).toBe(uma.perda.perdaCentavos);
    expect(duas.status).toBe(uma.status);
  });
});
