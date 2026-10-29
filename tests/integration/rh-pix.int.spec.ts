import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { PerfilUsuario, RhPapel } from '../../src/generated/prisma/client';
import { hashPassword } from '../../src/modules/auth/password.service';
import { app, login, resetDb, SENHA } from '../helpers/db';

const tokens: Record<string, string> = {};
const colabs: Record<string, string> = {};

async function pessoa(chave: string, nome: string, papel: RhPapel, perfil: PerfilUsuario = 'SEM_FINANCEIRO', gestorId?: string) {
  const c = await prisma.rhColaborador.create({ data: { nome, email: `${chave}@teste.local`, departamento: 'Copy', funcao: 'Copy', senioridade: 'pl', salarioCentavos: 500_000, inicio: new Date('2026-01-05'), gestorId } });
  await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome, perfil, rhPapel: papel, colaboradorId: c.id, senhaHash: await hashPassword(SENHA) } });
  tokens[chave] = `Bearer ${(await login(`${chave}@teste.local`)).body.data.accessToken}`;
  colabs[chave] = c.id;
}

const patch = (t: string, id: string, pix: string | null) => request(app).patch(`/api/v1/rh/colaboradores/${id}/pix`).set('Authorization', t).send({ pix });
const ficha = (t: string, id: string) => request(app).get(`/api/v1/rh/colaboradores/${id}`).set('Authorization', t);

describe('RH: chave PIX do colaborador', () => {
  beforeAll(async () => {
    await resetDb();
    await prisma.usuario.create({ data: { email: 'admin@teste.local', nome: 'Admin', perfil: 'ADMIN', senhaHash: await hashPassword(SENHA) } });
    tokens.admin = `Bearer ${(await login('admin@teste.local')).body.data.accessToken}`;
    await pessoa('rh', 'Pessoa RH', 'RH');
    await pessoa('gestor', 'Gestora', 'GESTOR');
    await pessoa('ana', 'Ana Souza', 'COLABORADOR', 'SEM_FINANCEIRO', colabs.gestor);
    await pessoa('bruno', 'Bruno Lima', 'COLABORADOR', 'SEM_FINANCEIRO', colabs.gestor);
  });
  afterAll(closeDatabase);

  it('só o RH grava; o CEO (admin), o gestor e o colaborador recebem acesso negado', async () => {
    expect((await patch(tokens.admin!, colabs.ana!, 'ana@pix.com')).status).toBe(403);
    expect((await patch(tokens.gestor!, colabs.ana!, 'ana@pix.com')).status).toBe(403);
    expect((await patch(tokens.ana!, colabs.ana!, 'ana@pix.com')).status).toBe(403);
    const r = await patch(tokens.rh!, colabs.ana!, '  ana@pix.com ');
    expect(r.status).toBe(200);
    expect(r.body.data.pix).toBe('ana@pix.com');
    expect((await prisma.rhColaborador.findUnique({ where: { id: colabs.ana! } }))!.pix).toBe('ana@pix.com');
  });

  it('a chave é dado pessoal: RH, CEO e o próprio veem; o gestor e os colegas não', async () => {
    await patch(tokens.rh!, colabs.bruno!, '11182215670');
    for (const t of [tokens.rh!, tokens.admin!, tokens.ana!]) expect((await ficha(t, colabs.ana!)).body.data.pix).toBe('ana@pix.com');
    expect((await ficha(tokens.gestor!, colabs.ana!)).body.data).not.toHaveProperty('pix'); // o gestor vê a equipe, mas não os dados pessoais
    expect((await ficha(tokens.bruno!, colabs.ana!)).status).toBe(404); // colega não vê nem a ficha
    const eu = await request(app).get('/api/v1/rh/colaboradores/eu').set('Authorization', tokens.ana!);
    expect(eu.body.data.colaborador.pix).toBe('ana@pix.com');
    const lista = await request(app).get('/api/v1/rh/colaboradores?limit=50').set('Authorization', tokens.rh!);
    expect(lista.body.data.find((c: { id: string }) => c.id === colabs.bruno)).toHaveProperty('pix', '11182215670');
    const listaGestor = await request(app).get('/api/v1/rh/colaboradores?limit=50').set('Authorization', tokens.gestor!);
    expect(listaGestor.body.data.find((c: { id: string }) => c.id === colabs.bruno)).not.toHaveProperty('pix');
  });

  it('valida a chave (sem espaços) e permite remover; colaborador inexistente dá 404', async () => {
    expect((await patch(tokens.rh!, colabs.ana!, 'duas palavras')).status).toBe(422);
    expect((await patch(tokens.rh!, colabs.ana!, 'ab')).status).toBe(422);
    expect((await patch(tokens.rh!, '00000000-0000-4000-8000-000000000000', 'abc@pix.com')).status).toBe(404);
    const r = await patch(tokens.rh!, colabs.ana!, null);
    expect(r.status).toBe(200);
    expect((await prisma.rhColaborador.findUnique({ where: { id: colabs.ana! } }))!.pix).toBeNull();
  });

  it('a auditoria registra a mudança sem gravar a chave', async () => {
    await patch(tokens.rh!, colabs.ana!, 'segredo@pix.com');
    const logs = await prisma.auditoria.findMany({ where: { acao: 'rh.pix_alterado', entidadeId: colabs.ana! } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('segredo@pix.com');
  });
});
