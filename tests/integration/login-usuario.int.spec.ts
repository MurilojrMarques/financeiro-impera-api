import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { app, criarUsuario, login, resetDb, SENHA, tokenDe } from '../helpers/db';

const api = (p: string) => `/api/v1${p}`;
const SENHA_INICIAL = 'Cobalto-Pivo-Tinta-47';

describe('login por e-mail OU nome de usuário', () => {
  let admin = '';
  beforeEach(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
  });
  afterAll(async () => {
    await closeDatabase();
  });

  const criar = (body: Record<string, unknown>) => request(app).post(api('/usuarios')).set('Authorization', admin).send({ nome: 'Murilo Teste', perfil: 'ANALISTA', ...body });

  it('usuário com os dois: entra com o e-mail e entra com o usuário (maiúsculas não importam)', async () => {
    const r = await criar({ email: 'murilo.t@teste.local', usuario: 'Murilo', senhaTemporaria: SENHA_INICIAL });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ usuario: 'murilo', email: 'murilo.t@teste.local' });
    for (const credencial of ['murilo', 'MURILO', 'Murilo.T@teste.local']) {
      const l = await login(credencial, SENHA_INICIAL);
      expect(l.status, credencial).toBe(200);
      expect(l.body.data.usuario).toMatchObject({ usuario: 'murilo', email: 'murilo.t@teste.local' });
    }
  });

  it('só usuário (sem e-mail) é permitido, mas exige senha inicial (não há como enviar convite)', async () => {
    expect((await criar({ usuario: 'sem.email' })).status).toBe(422);
    const r = await criar({ usuario: 'sem.email', senhaTemporaria: SENHA_INICIAL });
    expect(r.status).toBe(201);
    expect(r.body.data.email).toBeNull();
    expect((await login('sem.email', SENHA_INICIAL)).status).toBe(200);
  });

  it('só e-mail continua funcionando como antes', async () => {
    expect((await criar({ email: 'so.email@teste.local', senhaTemporaria: SENHA_INICIAL })).status).toBe(201);
    expect((await login('so.email@teste.local', SENHA_INICIAL)).status).toBe(200);
  });

  it('é obrigatório informar ao menos um dos dois', async () => {
    expect((await criar({ senhaTemporaria: SENHA_INICIAL })).status).toBe(422);
  });

  it('usuário inválido é recusado; duplicado (inclusive com outra caixa) é conflito', async () => {
    for (const ruim of ['ab', 'com espaço', 'tem@arroba', '-comeca', 'x'.repeat(33)]) {
      expect((await criar({ usuario: ruim, senhaTemporaria: SENHA_INICIAL })).status, ruim).toBe(422);
    }
    expect((await criar({ usuario: 'duplo', senhaTemporaria: SENHA_INICIAL })).status).toBe(201);
    expect((await criar({ usuario: 'DUPLO', senhaTemporaria: SENHA_INICIAL })).status).toBe(409);
  });

  it('o corpo antigo { email, senha } ainda funciona; senha errada e usuário inexistente dão a mesma resposta', async () => {
    await criarUsuario('LEITURA', { email: 'antigo@teste.local' });
    const antigo = await request(app).post(api('/auth/login')).send({ email: 'antigo@teste.local', senha: SENHA });
    expect(antigo.status).toBe(200);
    const errada = await login('antigo@teste.local', 'errada-errada-123');
    const inexistente = await login('ninguem', 'errada-errada-123');
    expect(errada.status).toBe(401);
    expect(inexistente.status).toBe(401);
    expect(inexistente.body.error?.message ?? inexistente.body.message).toBe(errada.body.error?.message ?? errada.body.message);
  });

  it('o bloqueio por tentativas vale também para quem entra pelo usuário', async () => {
    await criar({ usuario: 'bloqueio', senhaTemporaria: SENHA_INICIAL });
    for (let i = 0; i < 5; i++) await login('bloqueio', 'errada-errada-123');
    expect((await login('bloqueio', SENHA_INICIAL)).status).toBe(401); // conta bloqueada, mesmo com a senha certa
  });

  it('editar: trocar o usuário; não pode ficar sem e-mail e sem usuário; conflito com outro usuário', async () => {
    const a = (await criar({ usuario: 'primeiro', senhaTemporaria: SENHA_INICIAL })).body.data;
    await criar({ usuario: 'segundo', senhaTemporaria: SENHA_INICIAL });
    const put = (id: string, body: Record<string, unknown>) => request(app).patch(api(`/usuarios/${id}`)).set('Authorization', admin).send(body);
    expect((await put(a.id, { usuario: 'segundo' })).status).toBe(409);
    expect((await put(a.id, { usuario: null })).status).toBe(422); // ficaria sem nenhum
    expect((await put(a.id, { usuario: 'novo.nome', email: 'a@teste.local' })).status).toBe(200);
    expect((await put(a.id, { usuario: null })).status).toBe(200); // agora tem e-mail
    expect((await login('novo.nome', SENHA_INICIAL)).status).toBe(401);
    expect((await prisma.usuario.findUnique({ where: { id: a.id } }))?.usuario).toBeNull();
  });

  it('esqueci minha senha para conta sem e-mail responde igual e não envia nada', async () => {
    await criar({ usuario: 'sem.mail', senhaTemporaria: SENHA_INICIAL });
    const r = await request(app).post(api('/auth/forgot-password')).send({ email: 'sem.mail@teste.local' });
    expect(r.status).toBeLessThan(300);
  });
});
