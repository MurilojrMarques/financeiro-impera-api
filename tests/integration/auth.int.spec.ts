import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { env } from '../../src/config/env';
import { app, criarUsuario, login, resetDb, SENHA, tokenDe } from '../helpers/db';

const api = (p: string) => `/api/v1${p}`;

describe('autenticação e autorização', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it('rotas financeiras não são públicas: sem token => 401 (nenhuma exceção)', async () => {
    for (const p of ['/vendas', '/dashboard/resumo', '/front/resumo', '/backend/resumo', '/call-center/resumo', '/afiliados', '/custos', '/financeiro/dre', '/reembolsos', '/campanhas', '/redtrack/conversoes', '/admin/metricas', '/usuarios', '/integracoes/sheets/status', '/classificacoes/regras']) {
      const res = await request(app).get(api(p));
      expect(res.status, p).toBe(401);
      expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('login inválido: mesma resposta para e-mail inexistente e senha errada (sem enumerar contas)', async () => {
    await criarUsuario('ANALISTA');
    const a = await login('analista@teste.local', 'senha-errada-123');
    const b = await login('naoexiste@teste.local', 'qualquer-coisa-123');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const { requestId: _a, ...ea } = a.body.error;
    const { requestId: _b, ...eb } = b.body.error;
    expect(ea).toEqual(eb);
  });

  it('conta desativada não loga', async () => {
    await criarUsuario('ANALISTA', { ativo: false });
    expect((await login('analista@teste.local')).status).toBe(401);
  });

  it('login ok: Access Token no corpo, Refresh em cookie HttpOnly, senha nunca no hash em texto puro', async () => {
    const u = await criarUsuario('ANALISTA');
    const res = await login(u.email);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tokenType: 'Bearer', usuario: { email: u.email, perfil: 'ANALISTA' } });
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const rt = cookies.find((c) => c.startsWith('rt='))!;
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/SameSite=Lax/i);
    expect(rt).toMatch(/Path=\/api\/v1\/auth/);
    const dbUser = await prisma.usuario.findUnique({ where: { id: u.id } });
    expect(dbUser!.senhaHash).toMatch(/^\$argon2id\$/);
    expect(dbUser!.senhaHash).not.toContain(SENHA);
  });

  it('refresh token é guardado apenas como hash e rotaciona a cada uso; reuso revoga a sessão', async () => {
    const u = await criarUsuario('ANALISTA');
    const r1 = await request(app).post(api('/auth/login')).send({ email: u.email, senha: SENHA });
    const token1 = (r1.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rt='))!.split(';')[0].slice(3);
    const sess = await prisma.sessao.findFirst({ where: { usuarioId: u.id } });
    expect(sess!.refreshHash).not.toBe(token1);
    expect(sess!.refreshHash).toMatch(/^[0-9a-f]{64}$/);

    const r2 = await request(app).post(api('/auth/refresh')).send({ refreshToken: token1 });
    expect(r2.status).toBe(200);
    const token2 = (r2.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rt='))!.split(';')[0].slice(3);
    expect(token2).not.toBe(token1);

    // reuso do token antigo => 401 e a sessão inteira é revogada (token novo também deixa de valer)
    expect((await request(app).post(api('/auth/refresh')).send({ refreshToken: token1 })).status).toBe(401);
    expect((await request(app).post(api('/auth/refresh')).send({ refreshToken: token2 })).status).toBe(401);
    // e o access token emitido antes também morre com a sessão
    expect((await request(app).get(api('/auth/me')).set('Authorization', `Bearer ${r2.body.data.accessToken}`)).status).toBe(401);
  });

  it('refresh por cookie exige CSRF (double-submit)', async () => {
    const u = await criarUsuario('ANALISTA');
    const r1 = await login(u.email);
    const cookies = (r1.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]);
    const csrf = cookies.find((c) => c.startsWith('csrf='))!.slice(5);

    const semHeader = await request(app).post(api('/auth/refresh')).set('Cookie', cookies).send({});
    expect(semHeader.status).toBe(403);
    const errado = await request(app).post(api('/auth/refresh')).set('Cookie', cookies).set('X-CSRF-Token', 'outro').send({});
    expect(errado.status).toBe(403);
    const certo = await request(app).post(api('/auth/refresh')).set('Cookie', cookies).set('X-CSRF-Token', csrf).send({});
    expect(certo.status).toBe(200);
  });

  it('cookie csrf é legível pelo SPA (Path=/); o refresh token segue HttpOnly e restrito ao path de auth', async () => {
    const u = await criarUsuario('ANALISTA');
    const r1 = await login(u.email);
    const set = r1.headers['set-cookie'] as unknown as string[];
    const csrf = set.find((c) => c.startsWith('csrf='))!;
    const rt = set.find((c) => c.startsWith('rt='))!;
    expect(csrf).toMatch(/Path=\/(;|$)/);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(rt).toMatch(/Path=\/api\/v1\/auth/);
    expect(rt).toMatch(/HttpOnly/i);
    // logout limpa o csrf nos dois paths (novo e legado)
    const cookies = set.map((c) => c.split(';')[0]);
    const csrfVal = csrf.split(';')[0]!.slice(5);
    const out = await request(app).post(api('/auth/logout')).set('Cookie', cookies).set('X-CSRF-Token', csrfVal).send({});
    const limpos = (out.headers['set-cookie'] as unknown as string[]).filter((c) => c.startsWith('csrf='));
    expect(limpos.some((c) => /Path=\/(;|$)/.test(c))).toBe(true);
    expect(limpos.some((c) => /Path=\/api\/v1\/auth/.test(c))).toBe(true);
  });

  it('sessões: listar, revogar uma, encerrar todas', async () => {
    const u = await criarUsuario('ANALISTA');
    const a = await login(u.email);
    const b = await login(u.email);
    const authA = `Bearer ${a.body.data.accessToken}`;
    const lista = await request(app).get(api('/auth/sessions')).set('Authorization', authA);
    expect(lista.body.data).toHaveLength(2);
    expect(lista.body.data.filter((s: { atual: boolean }) => s.atual)).toHaveLength(1);

    const outra = lista.body.data.find((s: { atual: boolean }) => !s.atual);
    expect((await request(app).delete(api(`/auth/sessions/${outra.id}`)).set('Authorization', authA)).status).toBe(204);
    expect((await request(app).get(api('/auth/me')).set('Authorization', `Bearer ${b.body.data.accessToken}`)).status).toBe(401);
    expect((await request(app).get(api('/auth/me')).set('Authorization', authA)).status).toBe(200);

    expect((await request(app).post(api('/auth/logout-all')).set('Authorization', authA)).status).toBe(204);
    expect((await request(app).get(api('/auth/me')).set('Authorization', authA)).status).toBe(401);
  });

  it('não é possível revogar sessão de outro usuário', async () => {
    const u1 = await criarUsuario('ANALISTA', { email: 'a@x.local' });
    const u2 = await criarUsuario('ANALISTA', { email: 'b@x.local' });
    const l1 = await login(u1.email);
    await login(u2.email);
    const alheia = await prisma.sessao.findFirst({ where: { usuarioId: u2.id } });
    const res = await request(app).delete(api(`/auth/sessions/${alheia!.id}`)).set('Authorization', `Bearer ${l1.body.data.accessToken}`);
    expect(res.status).toBe(404);
  });

  it('token expirado, assinatura inválida, audiência/emissor errados e algoritmo none => 401', async () => {
    const u = await criarUsuario('ANALISTA');
    const l = await login(u.email);
    const sid = (jwt.decode(l.body.data.accessToken) as { sid: string }).sid;
    const claims = { sid };
    const opts = { subject: u.id, issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE };
    const tokens = {
      expirado: jwt.sign(claims, env.JWT_ACCESS_SECRET, { ...opts, expiresIn: -10 }),
      segredoErrado: jwt.sign(claims, 'x'.repeat(40), { ...opts, expiresIn: 60 }),
      audienciaErrada: jwt.sign(claims, env.JWT_ACCESS_SECRET, { ...opts, audience: 'outra', expiresIn: 60 }),
      emissorErrado: jwt.sign(claims, env.JWT_ACCESS_SECRET, { ...opts, issuer: 'outro', expiresIn: 60 }),
      none: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, sub: u.id })).toString('base64url')}.`,
    };
    for (const [nome, t] of Object.entries(tokens)) {
      expect((await request(app).get(api('/auth/me')).set('Authorization', `Bearer ${t}`)).status, nome).toBe(401);
    }
  });

  it('RBAC: LEITURA só dashboard/status; ANALISTA não vê custos/financeiro/usuários; FINANCEIRO não administra; ADMIN acessa tudo', async () => {
    const leitura = await tokenDe('LEITURA');
    const analista = await tokenDe('ANALISTA');
    const financeiro = await tokenDe('FINANCEIRO');
    const admin = await tokenDe('ADMIN');
    const status = (t: string, p: string, m: 'get' | 'post' = 'get') => request(app)[m](api(p)).set('Authorization', t).send({}).then((r) => r.status);

    expect(await status(leitura, '/dashboard/resumo')).toBe(200);
    expect(await status(leitura, '/integracoes/sheets/status')).toBe(200);
    expect(await status(leitura, '/vendas')).toBe(403);
    expect(await status(leitura, '/custos')).toBe(403);

    expect(await status(analista, '/vendas')).toBe(200);
    expect(await status(analista, '/afiliados')).toBe(200);
    expect(await status(analista, '/custos')).toBe(403);
    expect(await status(analista, '/financeiro/dre')).toBe(403);
    expect(await status(analista, '/usuarios')).toBe(403);
    expect(await status(analista, '/call-center/custos')).toBe(403);

    expect(await status(financeiro, '/custos')).toBe(200);
    expect(await status(financeiro, '/financeiro/dre')).toBe(200);
    expect(await status(financeiro, '/usuarios')).toBe(403);
    expect(await status(financeiro, '/admin/auditoria')).toBe(403);
    expect(await status(financeiro, '/integracoes/sheets/sincronizar', 'post')).toBe(403);

    expect(await status(admin, '/usuarios')).toBe(200);
    expect(await status(admin, '/admin/auditoria')).toBe(200);
    expect(await status(admin, '/custos')).toBe(200);
  });

  it('o perfil vem do banco, não do cliente: perfil no corpo do login é ignorado', async () => {
    const u = await criarUsuario('LEITURA');
    const res = await request(app).post(api('/auth/login')).send({ email: u.email, senha: SENHA, perfil: 'ADMIN' });
    expect(res.body.data.usuario.perfil).toBe('LEITURA');
  });

  it('senha temporária: bloqueia tudo (exceto trocar senha) até a troca; troca encerra outras sessões', async () => {
    const u = await criarUsuario('ANALISTA', { trocaSenha: true });
    const l = await login(u.email);
    const auth = `Bearer ${l.body.data.accessToken}`;
    expect(l.body.data.usuario.trocaSenhaObrigatoria).toBe(true);
    const bloqueado = await request(app).get(api('/vendas')).set('Authorization', auth);
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(app).get(api('/auth/me')).set('Authorization', auth)).status).toBe(200);

    const fraca = await request(app).patch(api('/auth/change-password')).set('Authorization', auth).send({ senhaAtual: SENHA, novaSenha: 'curta1' });
    expect(fraca.status).toBe(422);
    const errada = await request(app).patch(api('/auth/change-password')).set('Authorization', auth).send({ senhaAtual: 'errada-errada-1', novaSenha: 'NovaSenha-Forte-456' });
    expect(errada.status).toBe(401);
    const outraSessao = await login(u.email);
    const ok = await request(app).patch(api('/auth/change-password')).set('Authorization', auth).send({ senhaAtual: SENHA, novaSenha: 'NovaSenha-Forte-456' });
    expect(ok.status).toBe(204);
    expect((await request(app).get(api('/vendas')).set('Authorization', auth)).status).toBe(200);
    expect((await request(app).get(api('/auth/me')).set('Authorization', `Bearer ${outraSessao.body.data.accessToken}`)).status).toBe(401);
    expect((await login(u.email, 'NovaSenha-Forte-456')).status).toBe(200);
    expect((await login(u.email, SENHA)).status).toBe(401);
  });

  it('payload inválido => 422 com detalhes; JSON malformado => 400', async () => {
    const r = await request(app).post(api('/auth/login')).send({ email: 'nao-e-email', senha: '' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details.length).toBeGreaterThan(0);
    const m = await request(app).post(api('/auth/login')).set('Content-Type', 'application/json').send('{"email":');
    expect(m.status).toBe(400);
  });

  it('rate limit no login => 429 após exceder o limite', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++) statuses.push((await login('alvo@teste.local', 'qualquer-senha-1')).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
  });

  it('administração de usuários: cria com senha temporária, audita, desativa e revoga sessões; não se auto-desativa', async () => {
    const admin = await criarUsuario('ADMIN');
    const al = await login(admin.email);
    const auth = `Bearer ${al.body.data.accessToken}`;
    const criado = await request(app).post(api('/usuarios')).set('Authorization', auth).send({ nome: 'Fulano', email: 'Fulano@Empresa.com', perfil: 'ANALISTA', senhaTemporaria: 'Cobalto-Pivo-Tinta-47' });
    expect(criado.status).toBe(201);
    expect(criado.body.data).toMatchObject({ email: 'fulano@empresa.com', trocaSenhaObrig: true });
    expect(JSON.stringify(criado.body)).not.toMatch(/senhaHash|argon2/);
    expect((await request(app).post(api('/usuarios')).set('Authorization', auth).send({ nome: 'Dup', email: 'fulano@empresa.com', perfil: 'LEITURA', senhaTemporaria: 'Cobalto-Pivo-Tinta-47' })).status).toBe(409);

    const fl = await login('fulano@empresa.com', 'Cobalto-Pivo-Tinta-47');
    expect(fl.status).toBe(200);
    const desativa = await request(app).patch(api(`/usuarios/${criado.body.data.id}/status`)).set('Authorization', auth).send({ ativo: false });
    expect(desativa.status).toBe(200);
    expect((await request(app).get(api('/auth/me')).set('Authorization', `Bearer ${fl.body.data.accessToken}`)).status).toBe(401);
    expect((await request(app).patch(api(`/usuarios/${admin.id}/status`)).set('Authorization', auth).send({ ativo: false })).status).toBe(409);

    const aud = await request(app).get(api('/admin/auditoria?acao=usuario.')).set('Authorization', auth);
    expect(aud.body.data.map((a: { acao: string }) => a.acao)).toEqual(expect.arrayContaining(['usuario.criado', 'usuario.status']));
    expect(JSON.stringify(aud.body)).not.toContain('Cobalto-Pivo-Tinta-47');
  });

  it('health é público e mínimo; rota inexistente e erro não vazam stack/SQL', async () => {
    expect((await request(app).get('/health/live')).body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
    const nf = await request(app).get(api('/nao-existe'));
    expect(nf.status).toBe(404);
    expect(JSON.stringify(nf.body)).not.toMatch(/stack|prisma|SELECT/i);
  });

  it('CORS: origem não listada não recebe Access-Control-Allow-Origin', async () => {
    const ruim = await request(app).get('/health/live').set('Origin', 'https://malicioso.example');
    expect(ruim.headers['access-control-allow-origin']).toBeUndefined();
    const boa = await request(app).get('/health/live').set('Origin', 'http://localhost:5173');
    expect(boa.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(boa.headers['access-control-allow-credentials']).toBe('true');
  });

  it('Helmet ativo e Swagger acessível em desenvolvimento', async () => {
    const r = await request(app).get('/health/live');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect((await request(app).get('/docs/openapi.json')).body.openapi).toBe('3.0.3');
  });
});
