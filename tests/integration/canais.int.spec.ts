import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/config/database';
import { GoogleSheetsService } from '../../src/integrations/google-sheets/google-sheets.service';
import { SyncService } from '../../src/modules/sincronizacao/sync.service';
import { FakeSheets } from '../helpers/fake-sheets';
import { app, resetDb, tokenDe } from '../helpers/db';

/**
 * Colunas novas do EVENTOS (canal, subcanal, origem_lead): a venda fica com quem fechou.
 * Dia 19/10/2026, valor_sem_juros:
 *   front compra 300 | front upsell 100 | call center (Ana) 200 | recuperação (Pedro) 150 + 50 | back end SMS 80 | back end e-mail 20 | afiliado 70
 *   Back-end com utm_source "taboola" e tipo front (o canal manda, não o tipo nem o utm); teste=sim é ignorado.
 */
const ev = (pedido: string, extra: Record<string, string>) => ({
  recebido_em: '19/10/2026 10:00:00', pago_em: '19/10/2026 10:00:00', evento: 'pagamento', pedido, tipo: 'front', loja: 'Loja A',
  produto: '3 Kit', valor_total: '100,00', valor_sem_juros: '100,00', metodo: 'cartao', parcelas: '1', ...extra,
});

let admin = '';
let analista = '';
const get = (p: string, auth = admin) => request(app).get(`/api/v1${p}`).set('Authorization', auth);
const Q = 'de=2026-10-19&ate=2026-10-19';

describe('canais da planilha: front, call center, recuperação, back end, afiliado', () => {
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    analista = await tokenDe('ANALISTA');
    const s = new FakeSheets();
    s.addEvento(ev('F1', { canal: 'front', subcanal: 'compra', valor_sem_juros: '300,00' }));
    s.addEvento(ev('F2', { canal: 'front', subcanal: 'upsell', tipo: 'upsell', valor_sem_juros: '100,00' }));
    s.addEvento(ev('C1', { canal: 'call center', subcanal: 'Ana', tipo: 'call center', valor_sem_juros: '200,00' }));
    s.addEvento(ev('R1', { canal: 'recuperação de vendas', subcanal: 'Pedro', tipo: 'call center', valor_sem_juros: '150,00' }));
    s.addEvento(ev('R2', { canal: 'Recuperação de vendas', subcanal: 'Edinalva', tipo: 'front', valor_sem_juros: '50,00', origem_lead: 'SMS' }));
    s.addEvento(ev('B1', { canal: 'back end', subcanal: 'SMS', utm_source: 'taboola', valor_sem_juros: '80,00' }));
    s.addEvento(ev('B2', { canal: 'back end', subcanal: 'E-mail', valor_sem_juros: '20,00' }));
    s.addEvento(ev('A1', { canal: 'afiliado', afiliado: 'André Pinheiro', valor_sem_juros: '70,00' }));
    s.addEvento(ev('T1', { canal: 'front', teste: 'sim', valor_sem_juros: '999,00' }));
    const sync = new SyncService(new GoogleSheetsService(s), { batchSize: 10, lookbackRows: 3 });
    for (const r of await sync.executar(['HISTORICO', 'EVENTOS', 'REDTRACK'], 'INICIAL')) expect(r.status, r.erro).toMatch(/SUCESSO|PARCIAL/);
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it('cada grupo recebe só o que o canal indica (pedidos e valor)', async () => {
    const g = (await get(`/dashboard/receitas-por-grupo?${Q}&modo=APROVADAS`)).body.data.grupos;
    expect([g.front.pedidos, g.front.brutoCentavos]).toEqual([2, 40_000]);
    expect([g.callCenter.pedidos, g.callCenter.brutoCentavos]).toEqual([1, 20_000]);
    expect([g.recuperacao.pedidos, g.recuperacao.brutoCentavos]).toEqual([2, 20_000]);
    expect([g.backendOutros.pedidos, g.backendOutros.brutoCentavos]).toEqual([2, 10_000]);
    expect([g.afiliados.pedidos, g.afiliados.brutoCentavos]).toEqual([1, 7_000]);
    expect(g.naoClassificadas.pedidos).toBe(0);
  });

  it('a receita geral é a soma dos grupos; o back-end consolidado não é somado de novo', async () => {
    const d = (await get(`/dashboard/receitas-por-grupo?${Q}&modo=APROVADAS`)).body.data;
    expect(d.geral.brutoCentavos).toBe(40_000 + 20_000 + 20_000 + 10_000 + 7_000);
    expect(d.backendTotal.brutoCentavos).toBe(10_000 + 20_000 + 20_000); // back end + call center + recuperação
    const k = (await get(`/dashboard/kpis?${Q}`)).body.data;
    expect(k.receitaRecuperacaoCentavos).toBe(20_000);
  });

  it('/recuperacao: resumo e vendedores (subcanal)', async () => {
    const r = (await get(`/recuperacao/resumo?${Q}`, analista)).body.data;
    expect(r.pedidos).toBe(2);
    expect(r.brutoCentavos).toBe(20_000);
    const v = (await get(`/recuperacao/por-vendedor?${Q}`, analista)).body.data as { chave: string; pedidos: number }[];
    expect(v.map((x) => x.chave).sort()).toEqual(['Edinalva', 'Pedro']);
    const cc = (await get(`/call-center/por-atendente?${Q}`, analista)).body.data as { chave: string }[];
    expect(cc.map((x) => x.chave)).toEqual(['Ana']);
  });

  it('/backend: canais vêm do subcanal (SMS, e-mail) e a recuperação entra no consolidado', async () => {
    const c = (await get(`/backend/por-canal?${Q}`, analista)).body.data as { canal: string; pedidos: number }[];
    expect(c.map((x) => x.canal).sort()).toEqual(['E-mail', 'SMS']);
    const t = (await get(`/backend/total?${Q}`, analista)).body.data;
    expect(t.recuperacao.pedidos).toBe(2);
    expect(t.backendTotal.pedidos).toBe(2 + 1 + 2);
  });

  it('filtro por grupo aceita RECUPERACAO', async () => {
    const r = await get(`/vendas?${Q}&grupo=RECUPERACAO`, analista);
    expect(r.status).toBe(200);
    expect(r.body.meta.total).toBe(2);
  });
});
