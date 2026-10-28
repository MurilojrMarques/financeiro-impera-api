import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { GoogleSheetsService } from '../../src/integrations/google-sheets/google-sheets.service';
import { PARAMETROS_PADRAO } from '../../src/modules/trafego/trafego.domain';
import { SyncService } from '../../src/modules/sincronizacao/sync.service';
import { FakeSheets } from '../helpers/fake-sheets';
import { app, resetDb, tokenDe } from '../helpers/db';

const base = (pedido: string, extra: Record<string, string> = {}) => ({
  recebido_em: '19/10/2026 10:00:00', pago_em: '19/10/2026 10:00:00', evento: 'pagamento', pedido, tipo: 'front', loja: 'Loja A',
  produto: '6 Kit Teste - $397', valor_total: '397,00', valor_sem_juros: '397,00', comissao: '', comissao_fonte: '', metodo: 'cartao', parcelas: '1', ...extra,
});

let admin = '';
let analista = '';
let financeiro = '';
const get = (p: string, auth = admin) => request(app).get(`/api/v1${p}`).set('Authorization', auth);

describe('tráfego: faturamento Front, frete por remessa e janela de datas', () => {
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    analista = await tokenDe('ANALISTA');
    financeiro = await tokenDe('FINANCEIRO');
    // dia civil de São Paulo nos testes de janela; o padrão de produção (-180) é testado à parte
    await prisma.configuracaoFinanceira.create({ data: { chave: 'trafego.parametros', valor: { ...PARAMETROS_PADRAO, janelaDeslocamentoMin: 0 } } });
    const sheets = new FakeSheets();
    // 19/10 (SP): A1 e A2 do MESMO cliente (1 remessa) + upsell dele; B1 de outro cliente; 23:30 SP ainda é 19/10; 00:10 SP de 20/10 fica fora
    sheets.addEvento(base('A1', { cliente_id: '111' }));
    sheets.addEvento(base('A2', { cliente_id: '111', pago_em: '19/10/2026 15:00:00', recebido_em: '19/10/2026 15:00:00' }));
    sheets.addEvento(base('A3', { cliente_id: '111', tipo: 'upsell', produto: '(upsell) 3 Kit Teste', valor_sem_juros: '197,00', valor_total: '197,00', pago_em: '19/10/2026 10:05:00' }));
    sheets.addEvento(base('B1', { cliente_id: '222', pago_em: '19/10/2026 23:30:00', recebido_em: '19/10/2026 23:30:00' }));
    sheets.addEvento(base('C1', { cliente_id: '333', pago_em: '20/10/2026 00:10:00', recebido_em: '20/10/2026 00:10:00' }));
    // Call Center: 2 pedidos do mesmo cliente no dia = 1 remessa
    sheets.addEvento(base('K1', { tipo: 'call center', cliente_id: '444', produto: '[CALLCENTER] 3 Super Gel - $300', valor_sem_juros: '300,00', valor_total: '300,00' }));
    sheets.addEvento(base('K2', { tipo: 'call center', cliente_id: '444', produto: '[CALLCENTER] 3 Super Gel - $300', valor_sem_juros: '300,00', valor_total: '300,00', pago_em: '19/10/2026 11:00:00', recebido_em: '19/10/2026 11:00:00' }));
    // estorno não reduz o faturamento (critério Copy/Pulso)
    sheets.addEvento(base('B1', { cliente_id: '222', evento: 'estorno', recebido_em: '19/10/2026 23:50:00' }));
    const sync = new SyncService(new GoogleSheetsService(sheets), { batchSize: 10, lookbackRows: 3 });
    for (const r of await sync.executar(['HISTORICO', 'EVENTOS', 'REDTRACK'], 'INICIAL')) expect(r.status, r.erro).toMatch(/SUCESSO|PARCIAL/);
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it('janela do dia em America/Sao_Paulo e faturamento bruto (sem descontar estorno)', async () => {
    const res = await get('/trafego/resumo?de=2026-10-19&ate=2026-10-19');
    expect(res.status).toBe(200);
    // A1 + A2 + B1 = 3 × 397 + upsell 197 = 1.388,00 (C1 é do dia 20; B1 estornada continua no faturamento)
    expect(res.body.data.faturamentoCentavos).toBe(138_800);
    expect(res.body.data.pedidos).toBe(4); // 3 compras + 1 upsell: todos os pedidos Pagah do Front
    expect(res.body.data.conferencia.fonteBase).toBe('PAGAH');
    expect(res.body.meta.timezone).toBe('America/Sao_Paulo');
  });

  it('frete: pedidos do mesmo cliente no mesmo dia = 1 remessa', async () => {
    const d = (await get('/trafego/resumo?de=2026-10-19&ate=2026-10-19')).body.data;
    expect(d.remessas).toBe(2); // cliente 111 (A1+A2) e cliente 222
    expect(d.linhas.find((l: { codigo: string }) => l.codigo === 'frete').valorCentavos).toBe(2 * 1790);
    expect(d.unidades).toBe(6 * 3 + 3);
  });

  it('sem chave do RedTrack: investimento/ROAS/sobra indisponíveis e avisados (nunca zero)', async () => {
    const d = (await get('/trafego/resumo?de=2026-10-19&ate=2026-10-19')).body;
    expect(d.data.investimentoCentavos).toBeNull();
    expect(d.data.roasCentesimos).toBeNull();
    expect(d.data.roasRedtrackCentesimos).toBeNull();
    expect(d.data.frontRevenueRedtrackCentavos).toBeNull();
    expect(d.data.cpaRedtrackCentavos).toBeNull();
    expect(d.data.sobraCentavos).toBeNull();
    expect(d.meta.fonteInvestimento).toBe('NAO_CONFIGURADO');
    expect(d.data.avisos.join(' ')).toMatch(/RedTrack/);
  });

  it('parâmetros: ANALISTA lê mas não altera; FINANCEIRO altera e a conta muda', async () => {
    expect((await get('/trafego/parametros', analista)).status).toBe(200);
    const atual = (await get('/trafego/parametros', analista)).body.data.parametros;
    const put = (auth: string, body: unknown) => request(app).put('/api/v1/trafego/parametros').set('Authorization', auth).send(body as object);
    expect((await put(analista, atual)).status).toBe(403);
    expect((await put(financeiro, { ...atual, freteCentavos: 2000 })).status).toBe(200);
    const d = (await get('/trafego/resumo?de=2026-10-19&ate=2026-10-19')).body.data;
    expect(d.linhas.find((l: { codigo: string }) => l.codigo === 'frete').valorCentavos).toBe(2 * 2000);
    expect((await put(financeiro, { ...atual, taxaCartaoBp: -1 })).status).toBe(422);
  });

  it('janela alinhada ao RedTrack (-180 min): o dia fecha 3h antes da meia-noite de SP', async () => {
    const atual = (await get('/trafego/parametros', analista)).body.data.parametros;
    const put = await request(app).put('/api/v1/trafego/parametros').set('Authorization', financeiro).send({ ...atual, janelaDeslocamentoMin: -180 });
    expect(put.status).toBe(200);
    const res = await get('/trafego/resumo?de=2026-10-19&ate=2026-10-19');
    // [19/10 00:00Z, 20/10 00:00Z): A1 + A2 + upsell A3; B1 (23:30 SP = 02:30Z de 20/10) fica para o dia seguinte
    expect(res.body.data.faturamentoCentavos).toBe(99_100);
    expect(res.body.data.pedidos).toBe(3); // A1 + A2 + upsell A3
    expect(res.body.data.remessas).toBe(1);
    expect(res.body.meta.janelaTrafego).toMatchObject({ inicio: '2026-10-19T00:00:00.000Z', fim: '2026-10-20T00:00:00.000Z', deslocamentoMin: -180 });
  });

  it('Call Center: receita, frete por remessa, produto (gel R$ 9,90) e sobra com custos da operação', async () => {
    const res = await get('/call-center/receita-custos?de=2026-10-19&ate=2026-10-19', financeiro);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.faturamentoCentavos).toBe(60_000);
    expect(d.receitaLiquidaCentavos).toBe(60_000);
    expect(d.pedidos).toBe(2);
    expect(d.remessas).toBe(1);
    const v = (c: string) => d.linhas.find((l: { codigo: string }) => l.codigo === c).valorCentavos;
    expect(v('taxa-cartao')).toBe(6_000);
    expect(v('custo-produto')).toBe(6 * 990);
    expect(d.custosOperacaoCentavos).toBe(0);
    expect(d.sobraCentavos).toBe(60_000 - d.totalCustosCentavos);
    // ANALISTA vê a tabela, mas não os custos da operação nem a sobra
    const a = (await get('/call-center/receita-custos?de=2026-10-19&ate=2026-10-19', analista)).body.data;
    expect(a.custosOperacaoCentavos).toBeNull();
    expect(a.sobraCentavos).toBeNull();
  });

  it('exige autenticação', async () => {
    expect((await request(app).get('/api/v1/trafego/resumo')).status).toBe(401);
  });
});
