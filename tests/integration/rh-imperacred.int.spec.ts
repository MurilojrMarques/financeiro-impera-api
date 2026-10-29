import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { PerfilUsuario, RhPapel } from '../../src/generated/prisma/client';
import { hashPassword } from '../../src/modules/auth/password.service';
import { app, login, resetDb, SENHA } from '../helpers/db';

const tokens: Record<string, string> = {};
const colabs: Record<string, string> = {};

async function pessoa(chave: string, nome: string, papel: RhPapel, salarioCentavos = 500_000, perfil: PerfilUsuario = 'SEM_FINANCEIRO') {
  const c = await prisma.rhColaborador.create({ data: { nome, email: `${chave}@teste.local`, departamento: 'Copy', funcao: 'Copy', senioridade: 'pl', salarioCentavos, inicio: new Date('2026-01-05') } });
  await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome, perfil, rhPapel: papel, colaboradorId: c.id, senhaHash: await hashPassword(SENHA) } });
  tokens[chave] = `Bearer ${(await login(`${chave}@teste.local`)).body.data.accessToken}`;
  colabs[chave] = c.id;
}

const lanca = (t: string, valorCentavos: number, competencia = '2026-10', colaboradorId = colabs.ana!) =>
  request(app).post('/api/v1/rh/imperacred').set('Authorization', t).send({ colaboradorId, competencia, valorCentavos, observacao: 'adiantamento' });
const lista = (t: string, competencia = '2026-10') => request(app).get(`/api/v1/rh/imperacred?competencia=${competencia}`).set('Authorization', t);
const gerar = (mes: string, recalcular = false) => request(app).post(`/api/v1/rh/folha/${mes}/gerar${recalcular ? '?recalcular=true' : ''}`).set('Authorization', tokens.rh!);
const itemDaFolha = async (mes: string) => {
  const r = await request(app).get(`/api/v1/rh/folha/${mes}`).set('Authorization', tokens.rh!);
  return { folha: r.body.data, item: r.body.data.itens.find((i: { colaboradorId: string }) => i.colaboradorId === colabs.ana) };
};

describe('RH: ImperaCred (adiantamento de salário descontado no mês seguinte)', () => {
  beforeAll(async () => {
    await resetDb();
    await prisma.usuario.create({ data: { email: 'admin@teste.local', nome: 'Admin', perfil: 'ADMIN', senhaHash: await hashPassword(SENHA) } });
    tokens.admin = `Bearer ${(await login('admin@teste.local')).body.data.accessToken}`;
    await pessoa('rh', 'Pessoa RH', 'RH');
    await pessoa('ana', 'Ana Souza', 'COLABORADOR'); // salário de R$ 5.000
  });
  afterAll(closeDatabase);

  it('quem recebe 5.000 e adianta 2.500 em outubro recebe só 2.500 em novembro; outubro não muda', async () => {
    const r = await lanca(tokens.rh!, 250_000);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ valorCentavos: 250_000, competencia: '2026-10', descontaEm: '2026-11' });

    await gerar('2026-10');
    const out = await itemDaFolha('2026-10');
    expect(out.item).toMatchObject({ salarioCentavos: 500_000, imperaCredCentavos: 0, totalCentavos: 500_000 });

    await gerar('2026-11');
    const nov = await itemDaFolha('2026-11');
    expect(nov.item).toMatchObject({ salarioCentavos: 500_000, imperaCredCentavos: 250_000, totalCentavos: 250_000 });
    expect(nov.folha.resumo.imperaCredCentavos).toBe(250_000);
  });

  it('com a folha do mês seguinte já aberta, lançar ou apagar atualiza o desconto na hora', async () => {
    const mais = await lanca(tokens.rh!, 100_000);
    expect(mais.status).toBe(201);
    expect((await itemDaFolha('2026-11')).item).toMatchObject({ imperaCredCentavos: 350_000, totalCentavos: 150_000 });
    expect((await request(app).delete(`/api/v1/rh/imperacred/${mais.body.data.id}`).set('Authorization', tokens.rh!)).status).toBe(200);
    expect((await itemDaFolha('2026-11')).item).toMatchObject({ imperaCredCentavos: 250_000, totalCentavos: 250_000 });
  });

  it('o desconto não some ao editar comissão/bônus do item nem ao recalcular a folha', async () => {
    const { item } = await itemDaFolha('2026-11');
    const r = await request(app).patch(`/api/v1/rh/folha/2026-11/itens/${item.id}`).set('Authorization', tokens.rh!).send({ bonusCentavos: 50_000 });
    expect(r.status).toBe(200);
    expect(r.body.data.totalCentavos).toBe(500_000 + 50_000 - 250_000);
    await gerar('2026-11', true);
    expect((await itemDaFolha('2026-11')).item).toMatchObject({ imperaCredCentavos: 250_000, totalCentavos: 300_000 });
  });

  it('o adiantamento (somado aos do mês) não passa do salário mensal', async () => {
    const r = await lanca(tokens.rh!, 300_000); // 2.500 já adiantados + 3.000 > 5.000
    expect(r.status).toBe(422);
    expect((await lanca(tokens.rh!, 250_000)).status).toBe(201); // chega exatamente ao salário
    expect((await lista(tokens.rh!)).body.data.totalCentavos).toBe(500_000);
  });

  it('RH e CEO veem a lista; só o RH lança e apaga; o colaborador não vê nada', async () => {
    const l = (await lista(tokens.admin!)).body.data;
    expect(l).toMatchObject({ descontaEm: '2026-11', folhaDoDesconto: { status: 'ABERTA' } });
    expect(l.itens).toHaveLength(2);
    expect((await lanca(tokens.admin!, 10_000)).status).toBe(403);
    expect((await request(app).delete(`/api/v1/rh/imperacred/${l.itens[0].id}`).set('Authorization', tokens.admin!)).status).toBe(403);
    expect((await lista(tokens.ana!)).status).toBe(403);
    expect((await request(app).get('/api/v1/rh/imperacred?competencia=2026-10')).status).toBe(401);
    expect((await lanca(tokens.rh!, 10_000, '2026-10', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('folha do mês de desconto fechada: não dá para lançar nem apagar um ImperaCred que cairia nela', async () => {
    expect((await request(app).post('/api/v1/rh/folha/2026-11/fechar').set('Authorization', tokens.rh!)).status).toBe(200);
    expect((await lanca(tokens.rh!, 10_000)).status).toBe(409);
    const id = (await lista(tokens.rh!)).body.data.itens[0].id;
    expect((await request(app).delete(`/api/v1/rh/imperacred/${id}`).set('Authorization', tokens.rh!)).status).toBe(409);
    expect((await itemDaFolha('2026-11')).item.imperaCredCentavos).toBe(500_000); // a folha fechada ficou como estava
  });
});
