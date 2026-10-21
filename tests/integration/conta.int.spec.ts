import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { mailOutbox } from '../../src/shared/services/mail.service';
import { app, criarUsuario, login, resetDb, SENHA } from '../helpers/db';

const api = (p: string) => `/api/v1${p}`;
const NOVA = 'Cobalto-Pivo-Tinta-47';
const OUTRA = 'Lume-Verde-Rio-9281';

const extrairToken = (texto: string): string => /#token=([^\s"&]+)/.exec(texto)?.[1] ?? '';
const ultimoEmail = (para: string) => [...mailOutbox].reverse().find((m) => m.to === para);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pedirRedefinicao(email: string) {
  return request(app).post(api('/auth/forgot-password')).send({ email });
}
async function tokenDoEmail(email: string): Promise<string> {
  await pedirRedefinicao(email);
  await esperar(20);
  const m = ultimoEmail(email);
  expect(m, `e-mail para ${email}`).toBeTruthy();
  return extrairToken(m!.text);
}
const redefinir = (token: string, novaSenha: string) => request(app).post(api('/auth/reset-password')).send({ token, novaSenha });

describe('conta: recuperação de senha, convite, bloqueio e histórico', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  describe('esqueci minha senha', () => {
    it('resposta idêntica exista ou não a conta (sem enumeração); só a conta real recebe e-mail', async () => {
      await criarUsuario('ANALISTA');
      const real = await pedirRedefinicao('analista@teste.local');
      const falsa = await pedirRedefinicao('ninguem@teste.local');
      expect(real.status).toBe(202);
      expect(falsa.status).toBe(202);
      expect(real.body).toEqual(falsa.body);
      await esperar(20);
      expect(mailOutbox.map((m) => m.to)).toEqual(['analista@teste.local']);
    });

    it('conta desativada ou convite pendente não recebe link de redefinição', async () => {
      await criarUsuario('LEITURA', { email: 'inativo@teste.local', ativo: false });
      await pedirRedefinicao('inativo@teste.local');
      await esperar(20);
      expect(mailOutbox).toHaveLength(0);
    });

    it('o tempo de resposta não revela se a conta existe (piso fixo)', async () => {
      await criarUsuario('ANALISTA');
      const t = async (email: string) => {
        const i = Date.now();
        await pedirRedefinicao(email);
        return Date.now() - i;
      };
      expect(await t('analista@teste.local')).toBeGreaterThanOrEqual(280);
      expect(await t('ninguem@teste.local')).toBeGreaterThanOrEqual(280);
    });

    it('o link usa fragmento (#token=), o token tem alta entropia e só o hash é gravado', async () => {
      await criarUsuario('ANALISTA');
      const token = await tokenDoEmail('analista@teste.local');
      const msg = ultimoEmail('analista@teste.local')!;
      expect(msg.text).toMatch(/\/redefinir-senha#token=/);
      expect(msg.text).not.toMatch(/\?token=/);
      expect(token.length).toBeGreaterThanOrEqual(40);
      const gravado = await prisma.tokenUsuario.findMany();
      expect(gravado).toHaveLength(1);
      expect(gravado[0]!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(gravado)).not.toContain(token);
      expect(msg.html).not.toContain('<script');
    });

    it('um novo pedido invalida o link anterior (vale só o mais recente)', async () => {
      await criarUsuario('ANALISTA');
      const primeiro = await tokenDoEmail('analista@teste.local');
      const segundo = await tokenDoEmail('analista@teste.local');
      expect(primeiro).not.toBe(segundo);
      expect((await redefinir(primeiro, NOVA)).status).toBe(400);
      expect((await redefinir(segundo, NOVA)).status).toBe(204);
    });

    it('limite por conta (3/hora) e por IP (5 por 15 min): excesso é ignorado/barrado sem revelar nada', async () => {
      await criarUsuario('ANALISTA');
      for (let i = 0; i < 4; i++) {
        const r = await pedirRedefinicao('analista@teste.local');
        expect(r.status).toBe(202);
      }
      await esperar(20);
      expect(mailOutbox.filter((m) => m.to === 'analista@teste.local')).toHaveLength(3); // o 4º pedido não gerou e-mail
      const quinta = await pedirRedefinicao('analista@teste.local');
      expect(quinta.status).toBe(202);
      const sexta = await pedirRedefinicao('analista@teste.local');
      expect(sexta.status).toBe(429);
    });
  });

  describe('redefinir senha', () => {
    it('fluxo completo: troca a senha, encerra todas as sessões, avisa por e-mail e o link não é reutilizável', async () => {
      await criarUsuario('ANALISTA');
      const sessao = await login('analista@teste.local');
      const bearer = `Bearer ${sessao.body.data.accessToken}`;
      const token = await tokenDoEmail('analista@teste.local');

      expect((await request(app).post(api('/auth/link/validar')).send({ token })).body.data).toEqual({ valido: true, tipo: 'RESET_SENHA' });
      const ok = await redefinir(token, NOVA);
      expect(ok.status).toBe(204);

      expect((await login('analista@teste.local', SENHA)).status).toBe(401); // senha antiga
      expect((await login('analista@teste.local', NOVA)).status).toBe(200);
      expect((await request(app).get(api('/auth/me')).set('Authorization', bearer)).status).toBe(401); // sessão anterior encerrada
      expect(mailOutbox.some((m) => m.subject.includes('senha foi alterada'))).toBe(true);

      const reuso = await redefinir(token, OUTRA);
      expect(reuso.status).toBe(400);
      expect((await request(app).post(api('/auth/link/validar')).send({ token })).body.data.valido).toBe(false);

      const acoes = (await prisma.auditoria.findMany()).map((a) => a.acao);
      expect(acoes).toEqual(expect.arrayContaining(['auth.reset_solicitado', 'auth.reset_concluido']));
      expect(JSON.stringify(await prisma.auditoria.findMany())).not.toContain(token);
    });

    it('senha fraca é recusada SEM queimar o link (o usuário pode tentar de novo)', async () => {
      await criarUsuario('ANALISTA');
      const token = await tokenDoEmail('analista@teste.local');
      for (const fraca of ['curta1', 'somenteletrasaqui', 'senha1234567', 'analista12345', 'aaaaaaaaaaaa1']) {
        const r = await redefinir(token, fraca);
        expect(r.status, fraca).toBe(422);
      }
      expect((await request(app).post(api('/auth/link/validar')).send({ token })).body.data.valido).toBe(true);
      expect((await redefinir(token, NOVA)).status).toBe(204);
    });

    it('link expirado, inexistente ou adulterado recebe a MESMA resposta genérica', async () => {
      const u = await criarUsuario('ANALISTA');
      const token = await tokenDoEmail('analista@teste.local');
      await prisma.tokenUsuario.updateMany({ where: { usuarioId: u.id }, data: { expiraEm: new Date(Date.now() - 1000) } });
      const expirado = await redefinir(token, NOVA);
      const inexistente = await redefinir('x'.repeat(43), NOVA);
      const adulterado = await redefinir(`${token.slice(0, -2)}AA`, NOVA);
      for (const r of [expirado, inexistente, adulterado]) {
        expect(r.status).toBe(400);
        expect(r.body.error.message).toBe('Link inválido ou expirado. Solicite um novo.');
      }
    });

    it('não permite reaproveitar a senha atual nem as anteriores (histórico)', async () => {
      await criarUsuario('ANALISTA');
      expect((await redefinir(await tokenDoEmail('analista@teste.local'), NOVA)).status).toBe(204);
      // 2º ciclo: tentar voltar para a anterior (SENHA) ou ficar com a atual (NOVA)
      mailOutbox.length = 0;
      const t2 = await tokenDoEmail('analista@teste.local');
      const igualAtual = await redefinir(t2, NOVA);
      expect(igualAtual.status).toBe(422);
      expect(JSON.stringify(igualAtual.body)).toMatch(/usada recentemente/);
      const igualAnterior = await redefinir(t2, SENHA);
      expect(igualAnterior.status).toBe(422);
      expect((await redefinir(t2, OUTRA)).status).toBe(204);
    });

    it('uso simultâneo do mesmo link: só uma requisição vence', async () => {
      await criarUsuario('ANALISTA');
      const token = await tokenDoEmail('analista@teste.local');
      const rs = await Promise.all([redefinir(token, NOVA), redefinir(token, OUTRA), redefinir(token, `${NOVA}-x`)]);
      expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 400 || r.status === 422)).toHaveLength(2);
    });

    it('desativar a conta invalida os links pendentes', async () => {
      const u = await criarUsuario('ANALISTA');
      const token = await tokenDoEmail('analista@teste.local');
      await prisma.usuario.update({ where: { id: u.id }, data: { ativo: false } });
      expect((await redefinir(token, NOVA)).status).toBe(400);
    });

    it('redefinir a senha zera o bloqueio por tentativas', async () => {
      const u = await criarUsuario('ANALISTA');
      await prisma.usuario.update({ where: { id: u.id }, data: { bloqueadoAte: new Date(Date.now() + 600_000), falhasLogin: 3 } });
      expect((await redefinir(await tokenDoEmail('analista@teste.local'), NOVA)).status).toBe(204);
      expect((await login('analista@teste.local', NOVA)).status).toBe(200);
    });
  });

  describe('bloqueio por tentativas de login', () => {
    it('após 5 falhas bloqueia (mesma resposta 401), avisa o titular e o administrador desbloqueia', async () => {
      const admin = await criarUsuario('ADMIN');
      const alvo = await criarUsuario('ANALISTA');
      for (let i = 0; i < 5; i++) expect((await login(alvo.email, 'errada-errada-123')).status).toBe(401);

      // mesmo com a senha CERTA a conta segue bloqueada, e a resposta é idêntica à de credenciais inválidas
      const bloqueada = await login(alvo.email, SENHA);
      const invalida = await login(alvo.email, 'errada-errada-123');
      expect(bloqueada.status).toBe(401);
      expect(bloqueada.body.error.message).toBe(invalida.body.error.message);
      expect(mailOutbox.some((m) => m.to === alvo.email && m.subject.includes('suspeitas'))).toBe(true);

      const auth = `Bearer ${(await login(admin.email)).body.data.accessToken}`;
      const lista = await request(app).get(api('/usuarios')).set('Authorization', auth);
      expect(lista.body.data.find((u: { email: string }) => u.email === alvo.email).bloqueadoAte).toBeTruthy();
      expect((await request(app).post(api(`/usuarios/${alvo.id}/desbloquear`)).set('Authorization', auth)).status).toBe(200);
      expect((await login(alvo.email, SENHA)).status).toBe(200);
    });

    it('o bloqueio expira sozinho e o sucesso zera o contador de falhas', async () => {
      const alvo = await criarUsuario('ANALISTA');
      for (let i = 0; i < 3; i++) await login(alvo.email, 'errada-errada-123');
      expect((await login(alvo.email, SENHA)).status).toBe(200);
      expect((await prisma.usuario.findUnique({ where: { id: alvo.id } }))!.falhasLogin).toBe(0);

      await prisma.usuario.update({ where: { id: alvo.id }, data: { bloqueadoAte: new Date(Date.now() - 1000) } });
      expect((await login(alvo.email, SENHA)).status).toBe(200);
    });

    it('e-mail inexistente não cria estado nem bloqueio', async () => {
      for (let i = 0; i < 6; i++) expect((await login('fantasma@teste.local', 'qualquer-coisa-123')).status).toBe(401);
      expect(await prisma.usuario.count()).toBe(0);
    });
  });

  describe('convite de usuário (administrador nunca conhece a senha)', () => {
    async function admin() {
      const a = await criarUsuario('ADMIN');
      return `Bearer ${(await login(a.email)).body.data.accessToken}`;
    }

    it('cria sem senha, envia convite, o convidado define a própria senha e entra', async () => {
      const auth = await admin();
      const r = await request(app).post(api('/usuarios')).set('Authorization', auth).send({ nome: 'Maria Souza', email: 'Maria@Empresa.com', perfil: 'FINANCEIRO' });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ email: 'maria@empresa.com', convitePendente: true, conviteEnviado: true });
      expect(JSON.stringify(r.body)).not.toMatch(/senhaHash|argon2/);

      const msg = ultimoEmail('maria@empresa.com')!;
      expect(msg.text).toMatch(/\/ativar-conta#token=/);
      const token = extrairToken(msg.text);

      // antes de ativar ninguém consegue entrar (a senha gravada é aleatória)
      expect((await login('maria@empresa.com', NOVA)).status).toBe(401);
      expect((await request(app).post(api('/auth/link/validar')).send({ token })).body.data.tipo).toBe('CONVITE');

      // um link de convite NÃO serve como link de redefinição (e vice-versa)
      expect((await redefinir(token, NOVA)).status).toBe(400);

      const ativar = await request(app).post(api('/auth/activate')).send({ token, novaSenha: NOVA });
      expect(ativar.status).toBe(204);
      const entrou = await login('maria@empresa.com', NOVA);
      expect(entrou.status).toBe(200);
      expect(entrou.body.data.usuario).toMatchObject({ perfil: 'FINANCEIRO', trocaSenhaObrigatoria: false });
      expect((await prisma.usuario.findUnique({ where: { email: 'maria@empresa.com' } }))!.convitePendente).toBe(false);
      expect((await request(app).post(api('/auth/activate')).send({ token, novaSenha: OUTRA })).status).toBe(400); // uso único
    });

    it('reenviar convite invalida o anterior; depois de ativada a conta não aceita novo convite', async () => {
      const auth = await admin();
      const criado = await request(app).post(api('/usuarios')).set('Authorization', auth).send({ nome: 'João Lima', email: 'joao@empresa.com', perfil: 'LEITURA' });
      const primeiro = extrairToken(ultimoEmail('joao@empresa.com')!.text);
      const reenvio = await request(app).post(api(`/usuarios/${criado.body.data.id}/reenviar-convite`)).set('Authorization', auth);
      expect(reenvio.status).toBe(200);
      const segundo = extrairToken(ultimoEmail('joao@empresa.com')!.text);
      expect(segundo).not.toBe(primeiro);
      expect((await request(app).post(api('/auth/activate')).send({ token: primeiro, novaSenha: NOVA })).status).toBe(400);
      expect((await request(app).post(api('/auth/activate')).send({ token: segundo, novaSenha: NOVA })).status).toBe(204);
      expect((await request(app).post(api(`/usuarios/${criado.body.data.id}/reenviar-convite`)).set('Authorization', auth)).status).toBe(409);
    });

    it('senha do convite segue a política (não pode conter o nome/e-mail) e não queima o link', async () => {
      const auth = await admin();
      await request(app).post(api('/usuarios')).set('Authorization', auth).send({ nome: 'Carla Mendes', email: 'carla.mendes@empresa.com', perfil: 'ANALISTA' });
      const token = extrairToken(ultimoEmail('carla.mendes@empresa.com')!.text);
      expect((await request(app).post(api('/auth/activate')).send({ token, novaSenha: 'Carla-Mendes-2026' })).status).toBe(422);
      expect((await request(app).post(api('/auth/activate')).send({ token, novaSenha: NOVA })).status).toBe(204);
    });

    it('redefinição iniciada pelo admin envia o link ao usuário (o admin não define nem vê a senha)', async () => {
      const auth = await admin();
      await criarUsuario('ANALISTA', { email: 'ana@empresa.com' });
      const alvo = (await prisma.usuario.findUnique({ where: { email: 'ana@empresa.com' } }))!;
      const r = await request(app).post(api(`/usuarios/${alvo.id}/redefinir-senha`)).set('Authorization', auth);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(/token/i);
      const token = extrairToken(ultimoEmail('ana@empresa.com')!.text);
      expect((await redefinir(token, NOVA)).status).toBe(204);
    });

    it('apenas ADMIN gerencia convites e desbloqueios', async () => {
      await criarUsuario('FINANCEIRO');
      const fin = `Bearer ${(await login('financeiro@teste.local')).body.data.accessToken}`;
      const alvo = await criarUsuario('LEITURA');
      for (const p of ['reenviar-convite', 'redefinir-senha', 'desbloquear']) {
        expect((await request(app).post(api(`/usuarios/${alvo.id}/${p}`)).set('Authorization', fin)).status, p).toBe(403);
      }
      expect((await request(app).post(api('/usuarios')).set('Authorization', fin).send({ nome: 'X Y', email: 'x@y.com', perfil: 'LEITURA' })).status).toBe(403);
    });

    it('desativar um convidado invalida o convite pendente', async () => {
      const auth = await admin();
      const criado = await request(app).post(api('/usuarios')).set('Authorization', auth).send({ nome: 'Pedro Alves', email: 'pedro@empresa.com', perfil: 'LEITURA' });
      const token = extrairToken(ultimoEmail('pedro@empresa.com')!.text);
      await request(app).patch(api(`/usuarios/${criado.body.data.id}/status`)).set('Authorization', auth).send({ ativo: false });
      expect((await request(app).post(api('/auth/activate')).send({ token, novaSenha: NOVA })).status).toBe(400);
    });
  });

  describe('troca de senha logado', () => {
    it('aplica a política, impede reuso, avisa por e-mail e encerra as OUTRAS sessões', async () => {
      await criarUsuario('ANALISTA');
      const a = await login('analista@teste.local');
      const b = await login('analista@teste.local');
      const authA = `Bearer ${a.body.data.accessToken}`;
      const troca = (nova: string) => request(app).patch(api('/auth/change-password')).set('Authorization', authA).send({ senhaAtual: SENHA, novaSenha: nova });

      expect((await troca(SENHA)).status).toBe(422);
      expect((await troca('analista-2026-ok')).status).toBe(422); // contém o e-mail
      expect((await troca(NOVA)).status).toBe(204);
      await esperar(20);
      expect(mailOutbox.some((m) => m.to === 'analista@teste.local' && m.subject.includes('senha foi alterada'))).toBe(true);
      expect((await request(app).get(api('/auth/me')).set('Authorization', authA)).status).toBe(200); // sessão atual segue
      expect((await request(app).get(api('/auth/me')).set('Authorization', `Bearer ${b.body.data.accessToken}`)).status).toBe(401);
    });
  });

  describe('configuração', () => {
    it('informa que a recuperação por e-mail está disponível', async () => {
      const r = await request(app).get(api('/auth/config'));
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ recuperacaoSenha: true });
    });
  });
});
