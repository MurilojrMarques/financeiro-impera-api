import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { PerfilUsuario, RhPapel } from '../../src/generated/prisma/client';
import { hashPassword } from '../../src/modules/auth/password.service';
import { app, login, resetDb, SENHA } from '../helpers/db';

const CW_ANA = '11111111-1111-4111-8111-111111111111';
const CW_BRUNO = '22222222-2222-4222-8222-222222222222';
const CW_NEG = '33333333-3333-4333-8333-333333333333';

const fonte = vi.hoisted(() => ({ estado: 'FECHADO' as 'FECHADO' | 'PROVISORIO', disponivel: true, redtrack: true, landingNova: false }));
vi.mock('../../src/integrations/copy-supabase/copy-comissao', () => {
  const p = (copywriterId: string, nome: string, mc: number) => ({ copywriterId, nome, mcBrCentavos: mc * 100, mcBrExatoReais: mc, comissaoCentavos: mc * 5, aPagarCentavos: Math.max(0, mc * 5), ativo: true });
  return {
    comissaoCopyNoPeriodo: vi.fn(async () =>
      fonte.disponivel
        ? {
            disponivel: true,
            estado: fonte.estado,
            comissaoCentavos: 0,
            aPagarCentavos: 0,
            mcBrComissionavelCentavos: 0,
            mcBrSemComissaoCentavos: 0,
            pessoas: [p('11111111-1111-4111-8111-111111111111', 'ANA', 24_000), p('22222222-2222-4222-8222-222222222222', 'BRUNO', 16_000), p('33333333-3333-4333-8333-333333333333', 'NEG', -1_000)],
            copywriters: ['11111111-1111-4111-8111-111111111111:ANA', '22222222-2222-4222-8222-222222222222:BRUNO', '33333333-3333-4333-8333-333333333333:NEG'].map((x) => ({ id: x.split(':')[0]!, nome: x.split(':')[1]!, comissionavel: true, ativo: true })),
          }
        : { disponivel: false, motivo: 'REGRA_ANTERIOR', mensagem: 'antes de agosto' },
    ),
  };
});
vi.mock('../../src/integrations/redtrack/redtrack.landing', () => {
  const linha = (landing: string, campaign: string, cost: number, rev: number) => ({ network: 'Pagah', campaignId: 'c', campaign, landing, cost, rev });
  return {
    relatorioPorLanding: vi.fn(async () =>
      fonte.redtrack
        ? {
            ok: true,
            linhas: [
              linha('[FB][NE][BR][OF04][VT] - Nerve Pure - https://x.site/np/of04/lead1/', '[FB] - BR - VSL 04 - NEUROPATIA | 01/09 - G. GREG', 1000, 3000),
              ...(fonte.landingNova ? [linha('[FB][DA][BR][OF09][VT] - Produto Novo - https://x.site/da/pn/of09/vsl01/lead1/', '[FB] - BR - VSL 04 | G. GREG', 100, 300)] : []),
            ],
          }
        : { ok: false, mensagem: 'RedTrack respondeu HTTP 429.' },
    ),
  };
});

const tokens: Record<string, string> = {};
const colabs: Record<string, string> = {};

async function pessoa(chave: string, nome: string, papel: RhPapel, perfil: PerfilUsuario = 'SEM_FINANCEIRO') {
  const c = await prisma.rhColaborador.create({ data: { nome, email: `${chave}@teste.local`, departamento: 'Copy', funcao: 'Copy', senioridade: 'pl', salarioCentavos: 500_000, inicio: new Date('2026-01-05') } });
  await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome, perfil, rhPapel: papel, colaboradorId: c.id, senhaHash: await hashPassword(SENHA) } });
  tokens[chave] = `Bearer ${(await login(`${chave}@teste.local`)).body.data.accessToken}`;
  colabs[chave] = c.id;
}

const get = (t: string, mes = '2026-10') => request(app).get(`/api/v1/rh/comissoes?competencia=${mes}`).set('Authorization', t);
const vincula = (t: string, chave: string, colaboradorId: string | null) => request(app).put('/api/v1/rh/comissoes/vinculos').set('Authorization', t).send({ chave, colaboradorId });
const lanca = (t: string) => request(app).post('/api/v1/rh/comissoes/lancar').set('Authorization', t).send({ competencia: '2026-10' });
const item = (d: { itens: { chave: string }[] }, chave: string) => d.itens.find((i) => i.chave === chave) as Record<string, unknown>;

/** ANA: 5% de R$ 24.000 (R$ 1.200) + 5% da VSL dela (R$ 1.000 de MC BR = R$ 50); BRUNO R$ 800; Greg 5% e Iago 2,5% e Mineiro 1% de R$ 1.000 */
describe('RH: comissão do Front por colaborador', () => {
  beforeAll(async () => {
    await resetDb();
    await prisma.usuario.create({ data: { email: 'admin@teste.local', nome: 'Admin', perfil: 'ADMIN', senhaHash: await hashPassword(SENHA) } });
    tokens.admin = `Bearer ${(await login('admin@teste.local')).body.data.accessToken}`;
    await pessoa('rh', 'Pessoa RH', 'RH');
    await pessoa('ana', 'Ana Souza', 'COLABORADOR');
    await pessoa('bruno', 'Bruno Lima', 'COLABORADOR');
    await pessoa('outro', 'Bruno Outro', 'COLABORADOR');
    await pessoa('greg', 'Gregori Santos', 'COLABORADOR');
    await pessoa('iago', 'Iago Silva', 'COLABORADOR');
    await pessoa('mineiro', 'Igor Paiva', 'COLABORADOR');
    await prisma.comissaoVsl.create({ data: { chave: 'NE OF04 NERVE PURE', dono: 'ANA', editor: 'MINEIRO' } });
  });
  afterAll(closeDatabase);

  it('o RH vê cada pessoa com os blocos, as que estão em implementação, o total e as sugestões de vínculo', async () => {
    const d = (await get(tokens.rh!)).body.data;
    expect(d.disponivel).toBe(true);
    expect(d.itens).toHaveLength(7); // ANA, BRUNO, Mineiro, Iago, Greg + Lucas e João em implementação (a NEG fechou negativa e não aparece)
    expect(item(d, CW_ANA)).toMatchObject({ criativosCentavos: 120_000, vslCentavos: 5_000, otimizacoesCentavos: 0, apuradaCentavos: 125_000, aPagarCentavos: 125_000, status: 'CALCULADA' });
    expect(item(d, CW_NEG)).toBeUndefined();
    expect(item(d, 'GESTOR:GREG')).toMatchObject({ outrosCentavos: 5_000 });
    expect(item(d, 'FIXO:IAGO')).toMatchObject({ outrosCentavos: 2_500 });
    expect(item(d, 'EDITOR:MINEIRO')).toMatchObject({ outrosCentavos: 1_000 });
    expect(item(d, 'GESTOR:LUCAS')).toMatchObject({ status: 'EM_IMPLEMENTACAO', aPagarCentavos: null });
    expect(d.totais).toMatchObject({ aPagarCentavos: 213_500, semVinculo: 5, emImplementacao: 2 });
    expect(d.vsl).toMatchObject({ disponivel: true, semDono: [] });
    expect(d.sugestoes[CW_ANA].map((c: { nome: string }) => c.nome)).toEqual(['Ana Souza']);
    expect(d.sugestoes[CW_BRUNO].map((c: { nome: string }) => c.nome)).toEqual(['Bruno Lima', 'Bruno Outro']); // ambíguo: o RH escolhe
    expect(d.sugestoes['GESTOR:GREG'].map((c: { nome: string }) => c.nome)).toEqual(['Gregori Santos']);
    expect(d.sugestoes['FIXO:IAGO'].map((c: { nome: string }) => c.nome)).toEqual(['Iago Silva']);
    expect(d.sugestoes['EDITOR:MINEIRO'].map((c: { nome: string }) => c.nome)).toEqual(['Igor Paiva']);
  });

  it('só o RH vincula; a chave pode ser de copywriter ou de gestor/editor/fixo, e só fica com um colaborador', async () => {
    expect((await vincula(tokens.admin!, CW_ANA, colabs.ana!)).status).toBe(403);
    expect((await vincula(tokens.ana!, CW_ANA, colabs.ana!)).status).toBe(403);
    expect((await vincula(tokens.rh!, 'qualquer-coisa', colabs.ana!)).status).toBe(422);
    expect((await vincula(tokens.rh!, CW_ANA, colabs.ana!)).status).toBe(200);
    expect((await vincula(tokens.rh!, CW_BRUNO, colabs.outro!)).status).toBe(200);
    expect((await vincula(tokens.rh!, CW_BRUNO, colabs.bruno!)).status).toBe(200); // troca: sai do outro
    expect((await prisma.rhColaborador.findUnique({ where: { id: colabs.outro! } }))!.copywriterId).toBeNull();
    expect((await vincula(tokens.rh!, 'GESTOR:GREG', colabs.greg!)).status).toBe(200);
    expect((await prisma.rhColaborador.findUnique({ where: { id: colabs.greg! } }))!.comissaoChave).toBe('GESTOR:GREG');
    expect((await vincula(tokens.rh!, CW_BRUNO, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('visibilidade: só RH e CEO (admin) veem a comissão; gestor e colaborador não, nem os totais', async () => {
    for (const t of [tokens.rh!, tokens.admin!]) expect((await get(t)).body.data.itens).toHaveLength(7);
    expect((await get(tokens.ana!)).status).toBe(403); // nem a própria linha
    expect((await get(tokens.outro!)).status).toBe(403);
    expect((await request(app).get('/api/v1/rh/comissoes?competencia=2026-10')).status).toBe(401);
  });

  it('otimização validada: só o RH lança (R$ 500), entra na comissão da pessoa e some ao remover', async () => {
    const nova = { competencia: '2026-10', copywriter: 'ana', descricao: 'Nerve Pure LD12' };
    expect((await request(app).post('/api/v1/rh/comissoes/otimizacoes').set('Authorization', tokens.admin!).send(nova)).status).toBe(403);
    expect((await request(app).post('/api/v1/rh/comissoes/otimizacoes').set('Authorization', tokens.ana!).send(nova)).status).toBe(403);
    const criada = await request(app).post('/api/v1/rh/comissoes/otimizacoes').set('Authorization', tokens.rh!).send(nova);
    expect(criada.status).toBe(201);
    expect(criada.body.data).toMatchObject({ copywriter: 'ANA', valorCentavos: 50_000 });
    expect(item((await get(tokens.rh!)).body.data, CW_ANA)).toMatchObject({ otimizacoesCentavos: 50_000, aPagarCentavos: 175_000 });
    expect((await request(app).get('/api/v1/rh/comissoes/otimizacoes?competencia=2026-10').set('Authorization', tokens.admin!)).body.data).toHaveLength(1);
    expect((await request(app).get('/api/v1/rh/comissoes/otimizacoes?competencia=2026-10').set('Authorization', tokens.ana!)).status).toBe(403);
    expect((await request(app).delete(`/api/v1/rh/comissoes/otimizacoes/${criada.body.data.id}`).set('Authorization', tokens.admin!)).status).toBe(403);
    expect((await request(app).delete(`/api/v1/rh/comissoes/otimizacoes/${criada.body.data.id}`).set('Authorization', tokens.rh!)).status).toBe(200);
    expect(item((await get(tokens.rh!)).body.data, CW_ANA)).toMatchObject({ otimizacoesCentavos: 0, aPagarCentavos: 125_000 });
  });

  it('lançar na folha: exige folha gerada, mês fechado, RedTrack no ar, VSL com dono e vínculo de quem tem a pagar; o que está em implementação não é tocado', async () => {
    expect((await lanca(tokens.admin!)).status).toBe(403);
    expect((await lanca(tokens.rh!)).status).toBe(409); // sem folha
    await request(app).post('/api/v1/rh/folha/2026-10/gerar').set('Authorization', tokens.rh!);

    fonte.estado = 'PROVISORIO';
    const prov = await lanca(tokens.rh!);
    expect(prov.status).toBe(409);
    expect(prov.body.error.message).toMatch(/fechado/);
    fonte.estado = 'FECHADO';

    fonte.redtrack = false;
    const rt = await lanca(tokens.rh!);
    expect(rt.status).toBe(409);
    expect(rt.body.error.message).toMatch(/RedTrack/);
    fonte.redtrack = true;

    fonte.landingNova = true;
    const novo = await get(tokens.rh!);
    expect(novo.body.data.vsl.semDono).toEqual([{ vsl: 'DA OF09 PRODUTO NOVO VSL01', mcBrCentavos: 10_000 }]); // 300 × 0,70 − 100 × 1,10 = R$ 100
    const semDono = await lanca(tokens.rh!);
    expect(semDono.status).toBe(409);
    expect(semDono.body.error.message).toMatch(/Cadastre o dono/);
    expect((await request(app).put('/api/v1/rh/comissoes/vsl').set('Authorization', tokens.admin!).send({ chave: 'DA OF09 PRODUTO NOVO VSL01', dono: 'BRUNO', editor: null, mesmaVsl: null })).status).toBe(403);
    const cad = await request(app).put('/api/v1/rh/comissoes/vsl').set('Authorization', tokens.rh!).send({ chave: 'DA OF09 PRODUTO NOVO VSL01', dono: 'bruno', editor: null, mesmaVsl: null });
    expect(cad.status).toBe(200);
    expect(cad.body.data.dono).toBe('BRUNO');
    fonte.landingNova = false;

    // falta vincular quem tem valor a pagar (ANA e BRUNO já estão; Iago e Mineiro não)
    const falta = await lanca(tokens.rh!);
    expect(falta.status).toBe(409);
    expect(falta.body.error.message).toMatch(/Iago/);
    await vincula(tokens.rh!, 'FIXO:IAGO', colabs.iago!);
    await vincula(tokens.rh!, 'EDITOR:MINEIRO', colabs.mineiro!);

    const r = await lanca(tokens.rh!);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ pessoas: 5, alterados: 5, totalCentavos: 213_500 }); // ANA, BRUNO, Greg, Iago, Mineiro
    const itemAna = await prisma.rhFolhaItem.findFirst({ where: { colaboradorId: colabs.ana! } });
    expect(itemAna).toMatchObject({ comissaoCentavos: 125_000, totalCentavos: itemAna!.salarioCentavos + 125_000 });
    const itemGreg = await prisma.rhFolhaItem.findFirst({ where: { colaboradorId: colabs.greg! } });
    expect(itemGreg!.comissaoCentavos).toBe(5_000);
    expect((await lanca(tokens.rh!)).body.data.alterados).toBe(0); // idempotente
    expect(item((await get(tokens.rh!)).body.data, CW_ANA)).toMatchObject({ naFolhaCentavos: 125_000 });
  });

  it('bloqueia o lançamento com a folha fechada', async () => {
    await request(app).post('/api/v1/rh/folha/2026-10/fechar').set('Authorization', tokens.rh!);
    expect((await lanca(tokens.rh!)).status).toBe(409);
  });

  it('mês sem regra (antes de agosto) volta indisponível com o motivo', async () => {
    fonte.disponivel = false;
    const d = (await get(tokens.rh!, '2026-07')).body.data;
    expect(d).toMatchObject({ disponivel: false, motivo: 'REGRA_ANTERIOR', itens: [] });
    fonte.disponivel = true;
  });
});
