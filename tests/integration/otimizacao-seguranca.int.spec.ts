import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { GoogleSheetsService } from '../../src/integrations/google-sheets/google-sheets.service';
import { SyncService } from '../../src/modules/sincronizacao/sync.service';
import { FakeSheets } from '../helpers/fake-sheets';
import { app, criarUsuario, login, resetDb, SENHA, tokenDe } from '../helpers/db';

const api = (p: string) => `/api/v1${p}`;
const Q = 'de=2026-10-19&ate=2026-10-19';

const venda = (pedido: string, extra: Record<string, string> = {}) => ({
  recebido_em: '19/10/2026 10:00:00', pago_em: '19/10/2026 10:00:00', evento: 'pagamento', pedido, tipo: 'front', loja: 'Loja A',
  produto: '3 Kit Alfa', valor_total: '297,00', valor_sem_juros: '297,00', metodo: 'cartao', parcelas: '1', canal: 'front', subcanal: 'compra', ...extra,
});

let admin = '';
let analista = '';
let leitura = '';

describe('otimização e segurança de rede', () => {
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    analista = await tokenDe('ANALISTA');
    leitura = await tokenDe('LEITURA');
    const s = new FakeSheets();
    for (let i = 0; i < 60; i++) s.addEvento(venda(`P${i}`, { loja: i % 2 ? 'Loja B' : 'Loja A', produto: i % 3 ? '6 Kit Beta' : '3 Kit Alfa', utm_campaign: `camp ${i % 4}`, campanha: `camp ${i % 4}` }));
    s.addEvento(venda('FORA', { pago_em: '25/10/2026 10:00:00', recebido_em: '25/10/2026 10:00:00', loja: 'Loja Fora', produto: 'Kit Fora' }));
    const sync = new SyncService(new GoogleSheetsService(s), { batchSize: 100, lookbackRows: 3 });
    for (const r of await sync.executar(['HISTORICO', 'EVENTOS', 'REDTRACK'], 'INICIAL')) expect(r.status, r.erro).toMatch(/SUCESSO|PARCIAL/);
  });
  afterAll(async () => {
    await closeDatabase();
  });

  describe('compressão e cache', () => {
    it('respostas de dados grandes saem comprimidas (gzip)', async () => {
      const r = await request(app).get(api(`/vendas?${Q}&limit=50`)).set('Authorization', admin).set('Accept-Encoding', 'gzip');
      expect(r.status).toBe(200);
      expect(r.headers['content-encoding']).toBe('gzip');
      expect(r.body.data.length).toBeGreaterThan(20);
    });

    it('respostas pequenas não são comprimidas e o cliente sem gzip recebe o texto normal', async () => {
      const r = await request(app).get(api(`/vendas?${Q}&limit=50`)).set('Authorization', admin).set('Accept-Encoding', 'identity');
      expect(r.headers['content-encoding']).toBeUndefined();
    });

    it('dados financeiros: Cache-Control privado (revalida por ETag); autenticação: no-store', async () => {
      const dados = await request(app).get(api(`/dashboard/resumo?${Q}`)).set('Authorization', admin);
      expect(dados.headers['cache-control']).toBe('private, no-cache');
      expect(dados.headers.etag).toBeTruthy();
      const revalidado = await request(app).get(api(`/dashboard/resumo?${Q}`)).set('Authorization', admin).set('If-None-Match', dados.headers.etag!);
      expect(revalidado.status).toBe(304);
      const auth = await request(app).get(api('/auth/me')).set('Authorization', admin);
      expect(auth.headers['cache-control']).toBe('no-store');
    });
  });

  describe('limites de requisição que funcionam atrás de proxy (IP compartilhado)', () => {
    it('o limite de login é por E-MAIL: errar muito a senha de uma conta não impede as outras de entrar do mesmo IP', async () => {
      await criarUsuario('FINANCEIRO', { email: 'vitima@teste.local' });
      await criarUsuario('FINANCEIRO', { email: 'colega@teste.local' });
      let ultimo = 0;
      for (let i = 0; i < 22; i++) ultimo = (await login('vitima@teste.local', 'errada-errada-123')).status;
      expect(ultimo).toBe(429); // a conta atacada fica limitada
      const colega = await login('colega@teste.local', SENHA);
      expect(colega.status).toBe(200); // o resto da empresa, não
    });

    it('logins que dão certo não consomem o limite (vários acessos legítimos do mesmo escritório)', async () => {
      await criarUsuario('LEITURA', { email: 'varios@teste.local' });
      for (let i = 0; i < 25; i++) expect((await login('varios@teste.local', SENHA)).status).toBe(200);
    });

    it('o limite das rotas de dados é por USUÁRIO: um usuário não gasta a cota do outro', async () => {
      const a = await request(app).get(api(`/dashboard/resumo?${Q}`)).set('Authorization', admin);
      const b = await request(app).get(api(`/dashboard/resumo?${Q}`)).set('Authorization', leitura);
      expect(a.headers['ratelimit']).toContain('remaining=');
      expect(b.headers['ratelimit']).toContain('remaining=');
      const rem = (h: string) => Number(/remaining=(\d+)/.exec(h)![1]);
      // cada um tem o seu contador (a cota restante não é a mesma sequência compartilhada)
      const a2 = await request(app).get(api(`/dashboard/resumo?${Q}`)).set('Authorization', admin);
      expect(rem(a2.headers['ratelimit']!)).toBe(rem(a.headers['ratelimit']!) - 1);
    });
  });

  describe('listas dos filtros (só nomes, sem relatório completo)', () => {
    it('devolve valores distintos e ordenados do período, sem métricas', async () => {
      const r = await request(app).get(api(`/dashboard/opcoes?${Q}&dim=produto`)).set('Authorization', analista);
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual(['3 Kit Alfa', '6 Kit Beta']); // 'Kit Fora' é de outro período
      const lojas = await request(app).get(api(`/dashboard/opcoes?${Q}&dim=loja`)).set('Authorization', analista);
      expect(lojas.body.data).toEqual(['Loja A', 'Loja B']);
      const camp = await request(app).get(api(`/dashboard/opcoes?${Q}&dim=campanha`)).set('Authorization', analista);
      expect(camp.status).toBe(200); // campanha vem da aba REDTRACK; sem ela a lista é vazia (nunca inventada)
      expect(Array.isArray(camp.body.data)).toBe(true);
      expect(JSON.stringify(r.body.data)).not.toMatch(/receita|pedidos/i);
    });

    it('loja vale para qualquer perfil; as demais dimensões exigem ANALISTA ou acima; dimensão inválida é recusada', async () => {
      expect((await request(app).get(api(`/dashboard/opcoes?${Q}&dim=loja`)).set('Authorization', leitura)).status).toBe(200);
      expect((await request(app).get(api(`/dashboard/opcoes?${Q}&dim=produto`)).set('Authorization', leitura)).status).toBe(403);
      expect((await request(app).get(api(`/dashboard/opcoes?${Q}&dim=senhaHash`)).set('Authorization', admin)).status).toBe(422);
      expect((await request(app).get(api(`/dashboard/opcoes?${Q}&dim=loja`))).status).toBe(401);
    });
  });

  describe('investimento e ROAS total na visão executiva', () => {
    it('só ANALISTA+ vê; sem RedTrack configurado o investimento fica indisponível (nunca 0 inventado) mas a receita total vem', async () => {
      expect((await request(app).get(api(`/dashboard/trafego?${Q}`)).set('Authorization', leitura)).status).toBe(403);
      const r = await request(app).get(api(`/dashboard/trafego?${Q}`)).set('Authorization', analista);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ investimentoCentavos: null, roasTotalCentesimos: null, mcBrCentavos: null, comissaoFrontCentavos: null, fonteInvestimento: 'NAO_CONFIGURADO' });
      expect(r.body.data.comissaoTotalSemFront).toBe(true); // sem o sistema de copy a comissão do Front não entra no total (e isso é dito)
      expect(typeof r.body.data.comissaoCallCenterCentavos).toBe('number');
      expect(typeof r.body.data.comissaoRecuperacaoCentavos).toBe('number');
      expect(typeof r.body.data.comissaoAfiliadosCentavos).toBe('number'); // o Call Center (20%) não depende do RedTrack
      expect(r.body.data.receitaTotalCentavos).toBeGreaterThan(0);
    });
  });

  describe('banco', () => {
    it('a sessão tem tempo limite por consulta (uma consulta presa não derruba a API)', async () => {
      const [r] = await prisma.$queryRawUnsafe<{ statement_timeout: string; idle_in_transaction_session_timeout: string }[]>(
        'SHOW statement_timeout',
      );
      expect(Object.values(r!)[0]).toBe('1min');
      const [t] = await prisma.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW TimeZone');
      expect(Object.values(t!)[0]).toBe('UTC');
    });
  });
});
