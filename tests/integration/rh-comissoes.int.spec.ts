import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { PerfilUsuario, RhPapel } from '../../src/generated/prisma/client';
import { hashPassword } from '../../src/modules/auth/password.service';
import { app, login, resetDb, SENHA } from '../helpers/db';

const CW_ANA = '11111111-1111-4111-8111-111111111111';
const CW_BRUNO = '22222222-2222-4222-8222-222222222222';
const CW_NEG = '33333333-3333-4333-8333-333333333333';

const copy = vi.hoisted(() => ({ estado: 'FECHADO' as 'FECHADO' | 'PROVISORIO', disponivel: true }));
vi.mock('../../src/integrations/copy-supabase/copy-comissao', () => ({
  comissaoCopyNoPeriodo: vi.fn(async () =>
    copy.disponivel
      ? {
          disponivel: true,
          estado: copy.estado,
          comissaoCentavos: 120_000 + 80_000 - 5_000,
          aPagarCentavos: 200_000,
          mcBrComissionavelCentavos: 3_900_000,
          mcBrSemComissaoCentavos: 0,
          pessoas: [
            { copywriterId: '11111111-1111-4111-8111-111111111111', nome: 'ANA', mcBrCentavos: 2_400_000, comissaoCentavos: 120_000, aPagarCentavos: 120_000 },
            { copywriterId: '22222222-2222-4222-8222-222222222222', nome: 'BRUNO', mcBrCentavos: 1_600_000, comissaoCentavos: 80_000, aPagarCentavos: 80_000 },
            { copywriterId: '33333333-3333-4333-8333-333333333333', nome: 'NEG', mcBrCentavos: -100_000, comissaoCentavos: -5_000, aPagarCentavos: 0 },
          ],
        }
      : { disponivel: false, motivo: 'REGRA_ANTERIOR', mensagem: 'antes de agosto' },
  ),
}));

const tokens: Record<string, string> = {};
const colabs: Record<string, string> = {};

async function pessoa(chave: string, nome: string, papel: RhPapel, perfil: PerfilUsuario = 'SEM_FINANCEIRO') {
  const c = await prisma.rhColaborador.create({ data: { nome, email: `${chave}@teste.local`, departamento: 'Copy', funcao: 'Copy', senioridade: 'pl', salarioCentavos: 500_000, inicio: new Date('2026-01-05') } });
  await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome, perfil, rhPapel: papel, colaboradorId: c.id, senhaHash: await hashPassword(SENHA) } });
  tokens[chave] = `Bearer ${(await login(`${chave}@teste.local`)).body.data.accessToken}`;
  colabs[chave] = c.id;
}

const get = (t: string, mes = '2026-10') => request(app).get(`/api/v1/rh/comissoes?competencia=${mes}`).set('Authorization', t);
const vincula = (t: string, copywriterId: string, colaboradorId: string | null) => request(app).put('/api/v1/rh/comissoes/vinculos').set('Authorization', t).send({ copywriterId, colaboradorId });
const lanca = (t: string) => request(app).post('/api/v1/rh/comissoes/lancar').set('Authorization', t).send({ competencia: '2026-10' });

describe('RH: comissão do Front por colaborador', () => {
  beforeAll(async () => {
    await resetDb();
    await prisma.usuario.create({ data: { email: 'admin@teste.local', nome: 'Admin', perfil: 'ADMIN', senhaHash: await hashPassword(SENHA) } });
    tokens.admin = `Bearer ${(await login('admin@teste.local')).body.data.accessToken}`;
    await pessoa('rh', 'Pessoa RH', 'RH');
    await pessoa('ana', 'Ana Souza', 'COLABORADOR');
    await pessoa('bruno', 'Bruno Lima', 'COLABORADOR');
    await pessoa('outro', 'Bruno Outro', 'COLABORADOR');
  });
  afterAll(closeDatabase);

  it('antes do vínculo: o RH vê as linhas sem colaborador, com sugestão pelo nome, e o total', async () => {
    const d = (await get(tokens.rh!)).body.data;
    expect(d.disponivel).toBe(true);
    expect(d.itens).toHaveLength(3);
    expect(d.itens.every((i: { colaborador: unknown }) => i.colaborador === null)).toBe(true);
    expect(d.totais).toMatchObject({ aPagarCentavos: 200_000, semVinculo: 3 });
    expect(d.sugestoes[CW_ANA].map((c: { nome: string }) => c.nome)).toEqual(['Ana Souza']);
    expect(d.sugestoes[CW_BRUNO].map((c: { nome: string }) => c.nome)).toEqual(['Bruno Lima', 'Bruno Outro']); // ambíguo: o RH escolhe
  });

  it('só o RH vincula; o mesmo copywriter só fica com um colaborador', async () => {
    expect((await vincula(tokens.admin!, CW_ANA, colabs.ana!)).status).toBe(403);
    expect((await vincula(tokens.ana!, CW_ANA, colabs.ana!)).status).toBe(403);
    expect((await vincula(tokens.rh!, CW_ANA, colabs.ana!)).status).toBe(200);
    expect((await vincula(tokens.rh!, CW_BRUNO, colabs.outro!)).status).toBe(200);
    expect((await vincula(tokens.rh!, CW_BRUNO, colabs.bruno!)).status).toBe(200); // troca: sai do outro
    expect((await prisma.rhColaborador.findUnique({ where: { id: colabs.outro! } }))!.copywriterId).toBeNull();
    expect((await vincula(tokens.rh!, CW_BRUNO, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('visibilidade: RH e admin (como CEO) veem todos; colaborador só a própria linha, sem totais', async () => {
    for (const t of [tokens.rh!, tokens.admin!]) expect((await get(t)).body.data.itens).toHaveLength(3);
    const ana = (await get(tokens.ana!)).body.data;
    expect(ana.itens).toHaveLength(1);
    expect(ana.itens[0]).toMatchObject({ copywriterNome: 'ANA', aPagarCentavos: 120_000, colaborador: { nome: 'Ana Souza' } });
    expect(ana.totais).toBeNull();
    expect(ana.sugestoes).toEqual({});
    expect((await get(tokens.outro!)).body.data.itens).toHaveLength(0); // sem vínculo: nada
    expect((await request(app).get('/api/v1/rh/comissoes?competencia=2026-10')).status).toBe(401);
  });

  it('lançar na folha: exige folha gerada, vínculo de quem tem a pagar e mês fechado; negativo não vira desconto', async () => {
    expect((await lanca(tokens.admin!)).status).toBe(403);
    expect((await lanca(tokens.rh!)).status).toBe(409); // sem folha
    await request(app).post('/api/v1/rh/folha/2026-10/gerar').set('Authorization', tokens.rh!);

    copy.estado = 'PROVISORIO';
    const prov = await lanca(tokens.rh!);
    expect(prov.status).toBe(409);
    expect(prov.body.error.message).toMatch(/fechado/);
    copy.estado = 'FECHADO';

    const r = await lanca(tokens.rh!);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ pessoas: 2, alterados: 2, totalCentavos: 200_000 });
    const itemAna = await prisma.rhFolhaItem.findFirst({ where: { colaboradorId: colabs.ana! } });
    expect(itemAna).toMatchObject({ comissaoCentavos: 120_000, totalCentavos: itemAna!.salarioCentavos + 120_000 });
    expect((await lanca(tokens.rh!)).body.data.alterados).toBe(0); // idempotente
    expect((await get(tokens.rh!)).body.data.itens.find((i: { copywriterId: string }) => i.copywriterId === CW_ANA).naFolhaCentavos).toBe(120_000);
  });

  it('bloqueia o lançamento enquanto alguém com valor a pagar não tem vínculo, e com folha fechada', async () => {
    await vincula(tokens.rh!, CW_BRUNO, null);
    const r = await lanca(tokens.rh!);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/BRUNO/);
    await vincula(tokens.rh!, CW_BRUNO, colabs.bruno!);
    await request(app).post('/api/v1/rh/folha/2026-10/fechar').set('Authorization', tokens.rh!);
    expect((await lanca(tokens.rh!)).status).toBe(409);
  });

  it('mês sem regra (antes de agosto) volta indisponível com o motivo', async () => {
    copy.disponivel = false;
    const d = (await get(tokens.rh!, '2026-07')).body.data;
    expect(d).toMatchObject({ disponivel: false, motivo: 'REGRA_ANTERIOR', itens: [] });
    copy.disponivel = true;
  });
});
