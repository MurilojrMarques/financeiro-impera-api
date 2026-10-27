import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { PerfilUsuario, RhPapel } from '../../src/generated/prisma/client';
import { hashPassword } from '../../src/modules/auth/password.service';
import { app, login, resetDb, SENHA } from '../helpers/db';

const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const colabs: Record<string, string> = {};

async function pessoa(chave: string, nome: string, papel: RhPapel | null, perfil: PerfilUsuario, inicio = '2026-01-05') {
  const c = await prisma.rhColaborador.create({
    data: { nome, email: `${chave}@teste.local`, departamento: 'Copy', funcao: 'Copy', senioridade: 'pl', salarioCentavos: 500000, inicio: new Date(inicio) },
  });
  const u = await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome, perfil, rhPapel: papel, colaboradorId: papel ? c.id : null, senhaHash: await hashPassword(SENHA) } });
  tokens[chave] = `Bearer ${(await login(`${chave}@teste.local`)).body.data.accessToken}`;
  ids[chave] = u.id;
  colabs[chave] = c.id;
}

const nota = (chave: string, competencia: string, status: 'ENVIADO' | 'APROVADO' | 'REPROVADO', valor: number) =>
  prisma.rhDocumento.create({
    data: { colaboradorId: colabs[chave]!, tipo: 'NOTA_FISCAL', competencia, valorCentavos: valor, arquivoNome: `nf-${chave}.pdf`, arquivoCaminho: `${chave}/x.pdf`, mime: 'application/pdf', tamanhoBytes: 10, sha256: 'a'.repeat(64), status },
  });

describe('RH: visão mensal das notas fiscais e papel de RH na gestão de usuários', () => {
  beforeAll(async () => {
    await resetDb();
    await prisma.usuario.create({ data: { email: 'admin@teste.local', nome: 'Admin', perfil: 'ADMIN', senhaHash: await hashPassword(SENHA) } });
    tokens.admin = `Bearer ${(await login('admin@teste.local')).body.data.accessToken}`;
    await pessoa('rh', 'Pessoa RH', 'RH', 'SEM_FINANCEIRO');
    await pessoa('ana', 'Ana', 'COLABORADOR', 'SEM_FINANCEIRO');
    await pessoa('bruno', 'Bruno', 'COLABORADOR', 'SEM_FINANCEIRO');
    await pessoa('carla', 'Carla', 'COLABORADOR', 'SEM_FINANCEIRO');
    await pessoa('nova', 'Entrou em Novembro', 'COLABORADOR', 'SEM_FINANCEIRO', '2026-11-03');
    await nota('ana', '2026-10', 'APROVADO', 450_000);
    await nota('bruno', '2026-10', 'ENVIADO', 380_000);
    await nota('bruno', '2026-10', 'REPROVADO', 380_000); // a mais recente por criadoEm é a de cima (ENVIADO ou REPROVADO): só uma conta como "a nota"
    await nota('carla', '2026-09', 'APROVADO', 300_000); // outro mês
  });
  afterAll(closeDatabase);

  describe('GET /rh/documentos/resumo', () => {
    it('RH e ADMIN (como CEO) veem quem enviou e quem falta no mês; só quem estava na empresa entra', async () => {
      for (const t of [tokens.rh!, tokens.admin!]) {
        const r = await request(app).get('/api/v1/rh/documentos/resumo?competencia=2026-10').set('Authorization', t);
        expect(r.status).toBe(200);
        const d = r.body.data;
        expect(d.itens.map((i: { nome: string }) => i.nome)).toEqual(['Ana', 'Bruno', 'Carla', 'Pessoa RH']); // quem entrou em novembro não conta em outubro
        expect(d.totais).toMatchObject({ colaboradores: 4, comNota: 2, semNota: 2 });
        expect(d.totais.valorNotasCentavos).toBe(450_000 + 380_000);
        const ana = d.itens.find((i: { nome: string }) => i.nome === 'Ana');
        expect(ana.nota).toMatchObject({ status: 'APROVADO', valorCentavos: 450_000 });
        const carla = d.itens.find((i: { nome: string }) => i.nome === 'Carla');
        expect(carla.nota).toBeNull(); // a nota da Carla é de setembro
        expect(d.itens.find((i: { nome: string }) => i.nome === 'Bruno').quantidadeNotas).toBe(2);
      }
    });

    it('colaborador comum não vê a visão do mês de ninguém (403); sem login 401; mês inválido 422', async () => {
      expect((await request(app).get('/api/v1/rh/documentos/resumo?competencia=2026-10').set('Authorization', tokens.ana!)).status).toBe(403);
      expect((await request(app).get('/api/v1/rh/documentos/resumo?competencia=2026-10')).status).toBe(401);
      expect((await request(app).get('/api/v1/rh/documentos/resumo?competencia=2026-13').set('Authorization', tokens.rh!)).status).toBe(422);
    });
  });

  describe('PATCH /usuarios/:id/rh e perfil Colaborador', () => {
    it('só o ADMIN muda o papel de RH; a lista mostra papel e colaborador; perfil SEM_FINANCEIRO é aceito', async () => {
      const rh = (id: string, body: object, t: string) => request(app).patch(`/api/v1/usuarios/${id}/rh`).set('Authorization', t).send(body);
      expect((await rh(ids.ana!, { rhPapel: 'GESTOR' }, tokens.rh!)).status).toBe(403);
      const r = await rh(ids.ana!, { rhPapel: 'GESTOR' }, tokens.admin!);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ rhPapel: 'GESTOR', colaboradorId: colabs.ana });

      const lista = await request(app).get('/api/v1/usuarios?limit=50').set('Authorization', tokens.admin!);
      const ana = lista.body.data.find((u: { id: string }) => u.id === ids.ana);
      expect(ana).toMatchObject({ perfil: 'SEM_FINANCEIRO', rhPapel: 'GESTOR', colaborador: { nome: 'Ana' } });

      const p = await request(app).patch(`/api/v1/usuarios/${ids.bruno}/perfil`).set('Authorization', tokens.admin!).send({ perfil: 'LEITURA' });
      expect(p.status).toBe(200);
      const volta = await request(app).patch(`/api/v1/usuarios/${ids.bruno}/perfil`).set('Authorization', tokens.admin!).send({ perfil: 'SEM_FINANCEIRO' });
      expect(volta.body.data.perfil).toBe('SEM_FINANCEIRO');
    });

    it('não liga o mesmo colaborador a dois usuários, não aceita colaborador inexistente e ninguém muda o próprio papel', async () => {
      const rh = (id: string, body: object) => request(app).patch(`/api/v1/usuarios/${id}/rh`).set('Authorization', tokens.admin!).send(body);
      expect((await rh(ids.carla!, { rhPapel: 'COLABORADOR', colaboradorId: colabs.ana })).status).toBe(409);
      expect((await rh(ids.carla!, { rhPapel: 'COLABORADOR', colaboradorId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
      const admin = (await prisma.usuario.findUnique({ where: { email: 'admin@teste.local' } }))!;
      expect((await rh(admin.id, { rhPapel: 'RH' })).status).toBe(409);
      // tirar do RH
      const tira = await rh(ids.carla!, { rhPapel: null });
      expect(tira.body.data.rhPapel).toBeNull();
    });
  });
});
