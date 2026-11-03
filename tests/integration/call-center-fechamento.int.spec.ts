import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { reclassificarTodas } from '../../src/modules/classificacoes/classificacoes.service';
import { app, resetDb, tokenDe } from '../helpers/db';

const api = '/api/v1';
let financeiro = '';
let analista = '';

const venda = (pedido: string, extra: Record<string, unknown> = {}) =>
  prisma.venda.create({
    data: {
      pedido, grupo: 'CALL_CENTER', tipoVenda: 'CALL_CENTER', status: 'PAGO', canalPlanilha: 'call center', metodoPagamento: 'Cartão',
      valorVendaCentavos: 39_700, valorTotalCentavos: 47_832, comissaoFonte: 'AUSENTE', fonteVerdade: 'EVENTOS', hashConteudo: `h-${pedido}`,
      pagoEm: new Date('2026-10-15T12:00:00-03:00'), ...extra,
    },
  });

/**
 * A origem do Pagah é do VENDEDOR: o Pagah entrega o `vendedorId` (não a origem) e a tabela `vendedores_pagah` faz a ponte.
 * É o que decide o Call Center do fechamento do dono, sem planilha.
 */
describe('origem do Pagah pelo vendedor e fechamento do Call Center', () => {
  beforeAll(async () => {
    await resetDb();
    financeiro = await tokenDe('FINANCEIRO');
    analista = await tokenDe('ANALISTA');
    await prisma.vendedorPagah.createMany({
      data: [
        { vendedorId: '889387', origem: 'Jessica Teste', fonte: 'teste' },
        { vendedorId: '889380', origem: 'Call', fonte: 'teste' },
      ],
    });
    await venda('C1', { vendedorId: '889380' }); // vendedor "Call": é Call Center
    await venda('J1', { vendedorId: '889387' }); // origem com o próprio nome: não é Call Center, vai para Recuperação
    await venda('N1', { vendedorId: '777' }); // vendedor sem origem cadastrada: segue o canal da planilha
    await venda('H1', { vendedorId: '889380', origem: 'Whats' }); // a origem que a fonte trouxe nunca é trocada
    await venda('S1', { vendedorId: '889387', pagoEm: new Date('2026-09-15T12:00:00-03:00') }); // setembro não muda
    // Estornado em 26/10 e só virou chargeback em 03/11: a perda do pedido guarda o chargeback, mas em outubro ele já tinha sido devolvido.
    await venda('E1', {
      vendedorId: '889380', pagoEm: new Date('2026-10-23T15:40:00-03:00'), status: 'CHARGEBACK',
      estornadoEm: new Date('2026-10-26T16:25:22-03:00'), chargebackEm: new Date('2026-11-03T06:38:53-03:00'), perdaEm: new Date('2026-11-03T06:38:53-03:00'),
    });
    // Revertido só em 03/11 (sem estorno antes): em outubro ainda era venda.
    await venda('D1', {
      vendedorId: '889380', pagoEm: new Date('2026-10-28T11:10:00-03:00'), status: 'CHARGEBACK',
      chargebackEm: new Date('2026-11-03T06:38:53-03:00'), perdaEm: new Date('2026-11-03T06:38:53-03:00'),
    });
  });
  afterAll(closeDatabase);

  it('a tabela de vendedores preenche a origem e a classificação segue a regra do dono (só a partir de outubro)', async () => {
    const mudaram = await reclassificarTodas();
    expect(mudaram).toBeGreaterThan(0);
    const por = async (pedido: string) => prisma.venda.findUniqueOrThrow({ where: { pedido }, select: { origem: true, grupo: true } });
    expect(await por('C1')).toEqual({ origem: 'Call', grupo: 'CALL_CENTER' });
    expect(await por('J1')).toEqual({ origem: 'Jessica Teste', grupo: 'RECUPERACAO' });
    expect(await por('N1')).toEqual({ origem: null, grupo: 'CALL_CENTER' });
    expect(await por('H1')).toEqual({ origem: 'Whats', grupo: 'CALL_CENTER' });
    expect(await por('S1')).toEqual({ origem: 'Jessica Teste', grupo: 'CALL_CENTER' });
  });

  it('o fechamento do período soma só Call/Whats e conta à parte quem ficou sem origem', async () => {
    const r = await request(app).get(`${api}/call-center/fechamento?de=2026-10-01&ate=2026-10-31`).set('Authorization', financeiro);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.mes).toBeNull();
    // C1 (Call), H1 (Whats) e D1 (revertido só depois do mês). E1 já tinha sido estornado em outubro e fica de fora.
    expect(d.vendas.pedidos).toBe(3);
    expect(d.vendas.totalCentavos).toBe(3 * 39_700);
    expect(d.comissao.vendasCentavos).toBe(Math.round(3 * 39_700 * 0.2));
    expect(d.avisos.revertidasNoMes.pedidos).toBe(1);
    expect(d.avisos.revertidasDepois.pedidos).toBe(1);
    expect(d.avisos.semOrigem.pedidos).toBe(1); // N1: vendedor sem origem cadastrada
  });

  it('aceita o mês (AAAA-MM) ou o período, nunca os dois, e é só do Financeiro', async () => {
    const mes = await request(app).get(`${api}/call-center/fechamento?mes=2026-10`).set('Authorization', financeiro);
    expect(mes.status).toBe(200);
    expect(mes.body.data.mes).toBe('2026-10');
    expect(mes.body.data.vendas.pedidos).toBe(3);
    const ambos = await request(app).get(`${api}/call-center/fechamento?mes=2026-10&de=2026-10-01&ate=2026-10-31`).set('Authorization', financeiro);
    expect(ambos.status).toBe(422);
    const nenhum = await request(app).get(`${api}/call-center/fechamento`).set('Authorization', financeiro);
    expect(nenhum.status).toBe(422);
    const proibido = await request(app).get(`${api}/call-center/fechamento?mes=2026-10`).set('Authorization', analista);
    expect(proibido.status).toBe(403);
  });
});

describe('ajustes manuais do fechamento (rotas)', () => {
  beforeAll(async () => {
    await resetDb();
    financeiro = await tokenDe('FINANCEIRO');
    analista = await tokenDe('ANALISTA');
    await prisma.vendedorPagah.create({ data: { vendedorId: '889380', origem: 'Call', fonte: 'teste' } });
    await venda('9000001', { vendedorId: '889380' }); // venda de outubro
    // pago às 21:23:59 de 30/09: é de setembro, e o export do dono o traz em outubro
    await venda('9000002', { vendedorId: '889380', pagoEm: new Date('2026-09-30T21:23:59-03:00'), metodoPagamento: 'Pix', valorVendaCentavos: 19_700, valorTotalCentavos: 19_700 });
    await venda('9000003', { origem: 'Site' });
    await reclassificarTodas();
  });

  const post = (b: Record<string, unknown>, token = financeiro) => request(app).post(`${api}/call-center/fechamento/ajustes`).set('Authorization', token).send(b);
  const get = (qs: string) => request(app).get(`${api}/call-center/fechamento${qs}`).set('Authorization', financeiro);
  const motivo = 'Pago em 30/09 21:23:59 (evento do Pagah); o export do dono o lista em 01/10 e o fechamento dele o inclui.';
  const ajuste = { competencia: '2026-10', pedido: '9000002', acao: 'INCLUIR_VENDA', motivo };

  it('só o Financeiro ajusta; motivo curto, pedido inexistente ou sem origem Call/Whats são recusados', async () => {
    expect((await post(ajuste, analista)).status).toBe(403);
    expect((await post({ ...ajuste, motivo: 'curto' })).status).toBe(422);
    expect((await post({ ...ajuste, pedido: '9999999' })).status).toBe(404);
    expect((await post({ ...ajuste, pedido: '9000003' })).status).toBe(409); // origem Site
  });

  it('sem ajuste o pedido de setembro não conta; com ele, conta e o ajuste fica à vista, com o efeito', async () => {
    const antes = await get('?mes=2026-10');
    expect(antes.body.data.vendas.pedidos).toBe(1);
    expect(antes.body.data.ajustes).toEqual([]);

    const criado = await post(ajuste);
    expect(criado.status).toBe(201);
    expect(criado.body.data.criadoPorId).toBeTruthy();

    const depois = await get('?mes=2026-10');
    expect(depois.body.data.vendas.pedidos).toBe(2);
    expect(depois.body.data.vendas.totalCentavos).toBe(39_700 + 19_700);
    expect(depois.body.data.ajustes).toEqual([{ pedido: '9000002', acao: 'INCLUIR_VENDA', motivo, aplicado: true, efeitoCentavos: 19_700 }]);
  });

  it('o ajuste vale para o mês inteiro pedido por período, não para um período livre, e não muda a venda nem setembro', async () => {
    expect((await get('?de=2026-10-01&ate=2026-10-31')).body.data.vendas.pedidos).toBe(2);
    const livre = await get('?de=2026-10-05&ate=2026-10-31');
    expect(livre.body.data.ajustes).toEqual([]);
    expect(livre.body.data.vendas.pedidos).toBe(1);
    // setembro segue com o pedido, porque o ajuste é da competência 2026-10
    expect((await get('?mes=2026-09')).body.data.vendas.pedidos).toBe(1);
    expect((await prisma.venda.findUniqueOrThrow({ where: { pedido: '9000002' } })).pagoEm?.toISOString()).toBe('2026-10-01T00:23:59.000Z');
  });

  it('não repete o ajuste da mesma competência e pedido; remover desfaz e tudo fica na auditoria', async () => {
    expect((await post(ajuste)).status).toBe(409);
    const lista = await request(app).get(`${api}/call-center/fechamento/ajustes?competencia=2026-10`).set('Authorization', financeiro);
    expect(lista.body.data).toHaveLength(1);
    const id = lista.body.data[0].id as string;
    const del = await request(app).delete(`${api}/call-center/fechamento/ajustes/${id}`).set('Authorization', financeiro);
    expect(del.status).toBe(200);
    expect((await get('?mes=2026-10')).body.data.vendas.pedidos).toBe(1);
    const acoes = (await prisma.auditoria.findMany({ where: { acao: { startsWith: 'call_center.fechamento_ajuste' } }, select: { acao: true } })).map((a) => a.acao).sort();
    expect(acoes).toEqual(['call_center.fechamento_ajuste_criado', 'call_center.fechamento_ajuste_removido']);
  });
});

describe('data de fechamento da competência (posição)', () => {
  const dia = (s: string) => new Date(`${s}-03:00`);
  beforeAll(async () => {
    await resetDb();
    financeiro = await tokenDe('FINANCEIRO');
    analista = await tokenDe('ANALISTA');
    await prisma.vendedorPagah.create({ data: { vendedorId: '889380', origem: 'Call', fonte: 'teste' } });
    await venda('9100001', { vendedorId: '889380' });
    // vendida em outubro e revertida em 02/11, depois do fim do mês e antes do arquivo do dono (03/11)
    await venda('9100002', { vendedorId: '889380', status: 'CHARGEBACK', pagoEm: dia('2026-10-20T10:00:00'), chargebackEm: dia('2026-11-02T10:00:00'), perdaEm: dia('2026-11-02T10:00:00') });
    // revertida em 03/11, que o arquivo do dono ainda mostra como paga
    await venda('9100003', { vendedorId: '889380', status: 'CHARGEBACK', pagoEm: dia('2026-10-21T10:00:00'), chargebackEm: dia('2026-11-03T06:38:53'), perdaEm: dia('2026-11-03T06:38:53') });
    await reclassificarTodas();
  });

  const get = (qs = '?mes=2026-10') => request(app).get(`${api}/call-center/fechamento${qs}`).set('Authorization', financeiro);
  const put = (b: Record<string, unknown>, token = financeiro) => request(app).put(`${api}/call-center/fechamento/posicao`).set('Authorization', token).send(b);

  it('sem data de fechamento vale o fim do mês: as duas reversões de novembro ainda são venda de outubro', async () => {
    const r = await get();
    expect(r.body.data.posicao).toEqual({ em: null, fonte: 'FIM_DO_PERIODO' });
    expect(r.body.data.vendas.pedidos).toBe(3);
  });

  it('só o Financeiro fecha; a data tem de ser depois do fim do mês e não pode ser futura', async () => {
    expect((await put({ competencia: '2026-10', posicao: '2026-11-03' }, analista)).status).toBe(403);
    expect((await put({ competencia: '2026-10', posicao: '2026-10-31' })).status).toBe(409);
    expect((await put({ competencia: '2026-10', posicao: '2099-01-01' })).status).toBe(409);
    expect((await put({ competencia: '2026-10', posicao: 'amanhã' })).status).toBe(422);
  });

  it('fechado em 03/11, a tela e a API passam a mostrar a foto desse dia, sem ninguém escolher a data', async () => {
    expect((await put({ competencia: '2026-10', posicao: '2026-11-03' })).status).toBe(200);
    const r = await get();
    expect(r.body.data.posicao).toEqual({ em: '2026-11-03', fonte: 'FECHAMENTO' });
    expect(r.body.data.vendas.pedidos).toBe(2); // sai o revertido em 02/11; o de 03/11 de manhã ainda estava pago no arquivo dele
    // o mesmo mês pedido pelo período inteiro também usa a data fechada
    expect((await get('?de=2026-10-01&ate=2026-10-31')).body.data.posicao.fonte).toBe('FECHAMENTO');
    // um período livre não é uma competência: segue o fim do período
    expect((await get('?de=2026-10-05&ate=2026-10-31')).body.data.posicao.fonte).toBe('FIM_DO_PERIODO');
    // a data pedida na consulta vale mais, e fica marcada como informada
    expect((await get('?mes=2026-10&posicao=2026-11-04')).body.data.posicao).toEqual({ em: '2026-11-04', fonte: 'INFORMADA' });
  });

  it('desfazer volta ao fim do mês, e as duas ações ficam na auditoria', async () => {
    const del = await request(app).delete(`${api}/call-center/fechamento/posicao?competencia=2026-10`).set('Authorization', financeiro);
    expect(del.status).toBe(200);
    expect((await get()).body.data.posicao.fonte).toBe('FIM_DO_PERIODO');
    const acoes = (await prisma.auditoria.findMany({ where: { acao: { startsWith: 'call_center.fechamento_posicao' } }, select: { acao: true } })).map((a) => a.acao).sort();
    expect(acoes).toEqual(['call_center.fechamento_posicao_definida', 'call_center.fechamento_posicao_removida']);
  });
});
