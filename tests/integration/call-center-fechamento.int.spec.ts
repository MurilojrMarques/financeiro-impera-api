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
