import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { PerfilUsuario, RhPapel } from '../../src/generated/prisma/client';
import { hashPassword } from '../../src/modules/auth/password.service';
import { app, login, resetDb, SENHA } from '../helpers/db';

const api = (p: string) => `/api/v1/rh${p}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

interface Pessoa { colabId: string; token: string }
const p: Record<string, Pessoa> = {};
let tokenAdmin = '';
let tokenSemRh = '';

async function pessoa(chave: string, nome: string, papel: RhPapel, opts: { gestorId?: string; salario: number; perfil?: PerfilUsuario; depto?: string }): Promise<Pessoa> {
  const c = await prisma.rhColaborador.create({
    data: { nome, email: `${chave}@teste.local`, departamento: opts.depto ?? 'Dev/Infra', funcao: 'Dev', senioridade: 'pl', salarioCentavos: opts.salario, gestorId: opts.gestorId ?? null, inicio: new Date('2026-01-05T00:00:00Z'), cnpj: '00.000.000/0001-00' },
  });
  await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome, perfil: opts.perfil ?? 'SEM_FINANCEIRO', rhPapel: papel, colaboradorId: c.id, senhaHash: await hashPassword(SENHA) } });
  const r = await login(`${chave}@teste.local`);
  return { colabId: c.id, token: `Bearer ${r.body.data.accessToken}` };
}

const get = (url: string, t: string) => request(app).get(api(url)).set('Authorization', t);

describe('RH: permissões, salários, folha e documentos', () => {
  beforeAll(async () => {
    await resetDb();
    p.rh = await pessoa('rh', 'Pessoa RH', 'RH', { salario: 500000, perfil: 'FINANCEIRO' }); // RH e FINANCEIRO ao mesmo tempo
    p.ceo = await pessoa('ceo', 'Pessoa CEO', 'CEO', { salario: 1000000 });
    p.gestor = await pessoa('gestor', 'Gestora', 'GESTOR', { salario: 800000 });
    p.a = await pessoa('a', 'Ana Dev', 'COLABORADOR', { salario: 600000, gestorId: p.gestor!.colabId });
    p.b = await pessoa('b', 'Bruno Dev', 'COLABORADOR', { salario: 400000, gestorId: p.gestor!.colabId });
    p.c = await pessoa('c', 'Carla Outra Equipe', 'COLABORADOR', { salario: 300000, depto: 'CS' });
    const admin = await prisma.usuario.create({ data: { email: 'admin@teste.local', nome: 'Admin', perfil: 'ADMIN', senhaHash: await hashPassword(SENHA) } });
    void admin;
    tokenAdmin = `Bearer ${(await login('admin@teste.local')).body.data.accessToken}`;
    await prisma.usuario.create({ data: { email: 'sem@teste.local', nome: 'Sem RH', perfil: 'FINANCEIRO', senhaHash: await hashPassword(SENHA) } });
    tokenSemRh = `Bearer ${(await login('sem@teste.local')).body.data.accessToken}`;
  });
  afterAll(async () => {
    await closeDatabase();
  });

  describe('quem entra', () => {
    it('sem papel de RH não entra, nem ADMIN nem FINANCEIRO do financeiro; sem login => 401', async () => {
      expect((await get('/colaboradores', tokenAdmin)).status).toBe(403);
      expect((await get('/colaboradores', tokenSemRh)).status).toBe(403);
      expect((await request(app).get(api('/colaboradores'))).status).toBe(401);
    });

    it('colaborador comum (SEM_FINANCEIRO) não vê nenhuma tela do financeiro', async () => {
      for (const rota of ['/vendas', '/dashboard/resumo', '/custos', '/financeiro/dre']) {
        expect((await request(app).get(`/api/v1${rota}`).set('Authorization', p.a!.token)).status, rota).toBe(403);
      }
      expect((await get('/colaboradores/eu', p.a!.token)).status).toBe(200);
    });

    it('uma pessoa pode ser RH e FINANCEIRO ao mesmo tempo', async () => {
      expect((await get('/colaboradores', p.rh!.token)).status).toBe(200);
      expect((await request(app).get('/api/v1/vendas').set('Authorization', p.rh!.token)).status).toBe(200);
    });
  });

  describe('quem vê o quê', () => {
    it('RH e CEO veem todos, com salário', async () => {
      for (const t of [p.rh!.token, p.ceo!.token]) {
        const r = await get('/colaboradores?limit=50', t);
        expect(r.status).toBe(200);
        expect(r.body.meta.total).toBe(6);
        expect(r.body.data.every((c: { salarioCentavos?: number }) => typeof c.salarioCentavos === 'number')).toBe(true);
      }
    });

    it('gestor vê só a própria equipe (e ele mesmo), SEM salário dos outros e sem CNPJ/endereço', async () => {
      const r = await get('/colaboradores?limit=50', p.gestor!.token);
      expect(r.body.data.map((c: { nome: string }) => c.nome).sort()).toEqual(['Ana Dev', 'Bruno Dev', 'Gestora']);
      const ana = r.body.data.find((c: { nome: string }) => c.nome === 'Ana Dev');
      expect(ana).not.toHaveProperty('salarioCentavos');
      expect(ana).not.toHaveProperty('cnpj');
      const eu = r.body.data.find((c: { nome: string }) => c.nome === 'Gestora');
      expect(eu.salarioCentavos).toBe(800000); // o próprio salário ele vê
      expect((await get(`/colaboradores/${p.c!.colabId}`, p.gestor!.token)).status).toBe(404); // outra equipe: nem confirma que existe
      expect((await get(`/colaboradores/${p.a!.colabId}/movimentacoes`, p.gestor!.token)).status).toBe(403);
    });

    it('colaborador vê só o próprio cadastro, com o próprio salário', async () => {
      const r = await get('/colaboradores', p.a!.token);
      expect(r.body.meta.total).toBe(1);
      expect(r.body.data[0]).toMatchObject({ nome: 'Ana Dev', salarioCentavos: 600000 });
      expect((await get(`/colaboradores/${p.b!.colabId}`, p.a!.token)).status).toBe(404);
    });

    it('toda consulta a salário fica registrada na auditoria', async () => {
      await prisma.auditoria.deleteMany({});
      await get('/colaboradores?limit=50', p.rh!.token);
      await get(`/colaboradores/${p.a!.colabId}`, p.ceo!.token);
      const logs = await prisma.auditoria.findMany({ where: { acao: 'rh.salario_consultado' }, orderBy: { criadoEm: 'asc' } });
      expect(logs).toHaveLength(2);
      expect(logs[1]!.entidadeId).toBe(p.a!.colabId);
    });
  });

  describe('salário só se consulta (a origem é o sistema do RH)', () => {
    it('não existe rota para criar, editar, excluir colaborador nem para reajustar salário aqui', async () => {
      const id = p.b!.colabId;
      for (const t of [p.rh!.token, p.ceo!.token]) {
        expect((await request(app).post(api('/colaboradores')).set('Authorization', t).send({ nome: 'X', departamento: 'CS', salarioCentavos: 1 })).status).toBe(404);
        expect((await request(app).patch(api(`/colaboradores/${id}`)).set('Authorization', t).send({ funcao: 'Y' })).status).toBe(404);
        expect((await request(app).delete(api(`/colaboradores/${id}`)).set('Authorization', t)).status).toBe(404);
        expect((await request(app).post(api(`/colaboradores/${id}/movimentacoes`)).set('Authorization', t).send({ tipo: 'REAJUSTE', data: '2026-10-15', salarioNovoCentavos: 999999 })).status).toBe(404);
      }
      expect((await get(`/colaboradores/${id}`, p.rh!.token)).body.data.salarioCentavos).toBe(400000); // nada mudou
    });

    it('histórico de salário: RH/CEO e o próprio colaborador veem; gestor e colegas não', async () => {
      const id = p.b!.colabId;
      // o histórico chega da origem pela sincronização; aqui entra direto para testar a consulta
      await prisma.rhMovimentacao.createMany({
        data: [
          { colaboradorId: id, tipo: 'REAJUSTE', data: new Date('2026-10-15T00:00:00Z'), salarioAnteriorCentavos: 400000, salarioNovoCentavos: 450000 },
          { colaboradorId: id, tipo: 'PROMOCAO', data: new Date('2026-10-20T00:00:00Z'), salarioAnteriorCentavos: 450000, salarioNovoCentavos: 520000, cargoNovo: 'Dev Sr' },
        ],
      });
      await prisma.rhColaborador.update({ where: { id }, data: { salarioCentavos: 520000, funcao: 'Dev Sr', senioridade: 'sr' } });
      const hist = await get(`/colaboradores/${id}/movimentacoes`, p.ceo!.token);
      expect(hist.body.data.map((m: { salarioNovoCentavos: number }) => m.salarioNovoCentavos)).toEqual([520000, 450000]);
      expect((await get(`/colaboradores/${id}/movimentacoes`, p.b!.token)).status).toBe(200);
      expect((await get(`/colaboradores/${id}/movimentacoes`, p.a!.token)).status).toBe(404);
      expect((await get(`/colaboradores/${id}/movimentacoes`, p.gestor!.token)).status).toBe(403);
    });
  });

  describe('painel e folha', () => {
    it('painel da folha: só RH e CEO; soma dos salários dos ativos, sem multiplicador', async () => {
      expect((await get('/colaboradores/painel', p.gestor!.token)).status).toBe(403);
      const r = await get('/colaboradores/painel', p.ceo!.token);
      expect(r.status).toBe(200);
      const ativos = await prisma.rhColaborador.findMany({ where: { demissao: null } });
      expect(r.body.data.ativos).toBe(ativos.length);
      expect(r.body.data.folhaMensalCentavos).toBe(ativos.reduce((s, c) => s + c.salarioCentavos, 0));
      expect(r.body.data.baseDaFolha).toBe('SALARIO');
    });

    it('gerar a folha: salário do mês pelo histórico; lançar comissão/bônus/desconto; pagar; fechar', async () => {
      const gerar = (c: string, t = p.rh!.token) => request(app).post(api(`/folha/${c}/gerar`)).set('Authorization', t);
      expect((await get('/folha/2026-10', p.gestor!.token)).status).toBe(403);
      expect((await gerar('2026-10', p.ceo!.token)).status).toBe(403);
      const g = await gerar('2026-10');
      expect(g.status).toBe(201);
      expect(g.body.data.pessoas).toBe(6);
      expect((await gerar('2026-10')).body.data.incluidos).toBe(0); // repetir não duplica
      const f = await get('/folha/2026-10', p.ceo!.token);
      const bruno = f.body.data.itens.find((i: { colaboradorId: string }) => i.colaboradorId === p.b!.colabId);
      expect(bruno.salarioCentavos).toBe(520000); // salário vigente no fim de outubro (após a promoção de 20/10)
      // setembro: antes dos reajustes, Bruno ganhava 4.000,00
      await gerar('2026-09');
      const set = await get('/folha/2026-09', p.rh!.token);
      expect(set.body.data.itens.find((i: { colaboradorId: string }) => i.colaboradorId === p.b!.colabId).salarioCentavos).toBe(400000);

      const edit = await request(app).patch(api(`/folha/2026-10/itens/${bruno.id}`)).set('Authorization', p.rh!.token).send({ comissaoCentavos: 100000, bonusCentavos: 50000, descontoCentavos: 20000 });
      expect(edit.status).toBe(200);
      expect(edit.body.data.totalCentavos).toBe(520000 + 100000 + 50000 - 20000);
      expect((await request(app).patch(api(`/folha/2026-10/itens/${bruno.id}`)).set('Authorization', p.rh!.token).send({ descontoCentavos: 99999999 })).status).toBe(422); // total negativo
      const pago = await request(app).patch(api(`/folha/2026-10/itens/${bruno.id}`)).set('Authorization', p.rh!.token).send({ status: 'PAGO', pagoEm: '2026-11-05' });
      expect(pago.body.data).toMatchObject({ status: 'PAGO' });

      expect((await request(app).post(api('/folha/2026-10/fechar')).set('Authorization', p.rh!.token)).status).toBe(200);
      expect((await gerar('2026-10')).status).toBe(409);
      expect((await request(app).patch(api(`/folha/2026-10/itens/${bruno.id}`)).set('Authorization', p.rh!.token).send({ comissaoCentavos: 1 })).status).toBe(409); // fechada
      const resumo = (await get('/folha/2026-10', p.rh!.token)).body.data.resumo;
      expect(resumo.totalCentavos).toBe(resumo.pagoCentavos + resumo.pendenteCentavos);
    });

    it('colaborador que entrou depois ou saiu antes do mês não entra na folha', async () => {
      await prisma.rhColaborador.create({ data: { nome: 'Entrou Depois', departamento: 'CS', salarioCentavos: 300000, inicio: new Date('2026-12-10T00:00:00Z') } });
      await prisma.rhColaborador.create({ data: { nome: 'Saiu Antes', departamento: 'CS', salarioCentavos: 300000, inicio: new Date('2026-01-01T00:00:00Z'), demissao: new Date('2026-07-31T00:00:00Z') } });
      const g = await request(app).post(api('/folha/2026-08/gerar')).set('Authorization', p.rh!.token);
      const nomes = (await get('/folha/2026-08', p.rh!.token)).body.data.itens.map((i: { colaborador: { nome: string } }) => i.colaborador.nome);
      expect(g.body.data.pessoas).toBe(6);
      expect(nomes).not.toContain('Entrou Depois');
      expect(nomes).not.toContain('Saiu Antes');
    });
  });

  describe('folha proporcional', () => {
    it('quem entrou ou saiu no meio do mês recebe salário ÷ 30 × dias trabalhados; quem ficou o mês todo, o salário cheio', async () => {
      await prisma.rhColaborador.create({ data: { nome: 'Entrou em Novembro', departamento: 'CS', salarioCentavos: 300000, inicio: new Date('2026-11-10T00:00:00Z') } });
      await prisma.rhColaborador.create({ data: { nome: 'Saiu em Novembro', departamento: 'CS', salarioCentavos: 600000, inicio: new Date('2026-01-01T00:00:00Z'), demissao: new Date('2026-11-15T00:00:00Z') } });
      const g = await request(app).post(api('/folha/2026-11/gerar')).set('Authorization', p.rh!.token);
      expect(g.status).toBe(201);
      const itens = (await get('/folha/2026-11', p.rh!.token)).body.data.itens as { colaborador: { nome: string }; salarioMensalCentavos: number; diasTrabalhados: number; salarioCentavos: number; totalCentavos: number }[];
      const por = (nome: string) => itens.find((i) => i.colaborador.nome === nome)!;
      expect(por('Entrou em Novembro')).toMatchObject({ diasTrabalhados: 21, salarioMensalCentavos: 300000, salarioCentavos: 210000, totalCentavos: 210000 }); // 10 a 30 de novembro
      expect(por('Saiu em Novembro')).toMatchObject({ diasTrabalhados: 15, salarioMensalCentavos: 600000, salarioCentavos: 300000 });
      expect(por('Ana Dev')).toMatchObject({ diasTrabalhados: 30, salarioCentavos: 600000 });
    });

    it('comissão, bônus e desconto somam ao salário proporcional; recalcular refaz só salário e dias', async () => {
      const f = await get('/folha/2026-11', p.rh!.token);
      const item = f.body.data.itens.find((i: { colaborador: { nome: string } }) => i.colaborador.nome === 'Entrou em Novembro');
      const e = await request(app).patch(api(`/folha/2026-11/itens/${item.id}`)).set('Authorization', p.rh!.token).send({ bonusCentavos: 10000 });
      expect(e.body.data.totalCentavos).toBe(220000);
      // corrige a data de entrada e recalcula: a folha aberta acompanha, e o bônus fica
      await prisma.rhColaborador.updateMany({ where: { nome: 'Entrou em Novembro' }, data: { inicio: new Date('2026-11-20T00:00:00Z') } });
      const r = await request(app).post(api('/folha/2026-11/gerar?recalcular=true')).set('Authorization', p.rh!.token);
      expect(r.body.data.recalculados).toBe(1);
      const novo = (await get('/folha/2026-11', p.rh!.token)).body.data.itens.find((i: { colaborador: { nome: string } }) => i.colaborador.nome === 'Entrou em Novembro');
      expect(novo).toMatchObject({ diasTrabalhados: 11, salarioCentavos: 110000, bonusCentavos: 10000, totalCentavos: 120000 });
    });

    it('fevereiro (28 dias): quem ficou o mês todo recebe o salário cheio', async () => {
      await request(app).post(api('/folha/2026-02/gerar')).set('Authorization', p.rh!.token);
      const ana = (await get('/folha/2026-02', p.rh!.token)).body.data.itens.find((i: { colaborador: { nome: string } }) => i.colaborador.nome === 'Ana Dev');
      expect(ana).toMatchObject({ diasTrabalhados: 30, salarioCentavos: 600000 });
    });
  });

  describe('documentos (NF e comprovantes)', () => {
    const enviar = (t: string, campos: Record<string, string>, arquivo: Buffer = PDF, nome = 'nf.pdf') => {
      let r = request(app).post(api('/documentos')).set('Authorization', t);
      for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
      return r.attach('arquivo', arquivo, nome);
    };

    it('colaborador envia a própria NF; não envia comprovante nem em nome de outro', async () => {
      const ok = await enviar(p.a!.token, { tipo: 'NOTA_FISCAL', competencia: '2026-10', valorCentavos: '600000' });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ colaboradorId: p.a!.colabId, tipo: 'NOTA_FISCAL', mime: 'application/pdf', status: 'ENVIADO' });
      expect((await enviar(p.a!.token, { tipo: 'COMPROVANTE_PAGAMENTO', competencia: '2026-10' })).status).toBe(403);
      expect((await enviar(p.a!.token, { tipo: 'NOTA_FISCAL', colaboradorId: p.b!.colabId })).status).toBe(403);
    });

    it('só PDF/PNG/JPG/WEBP pelo conteúdo: um executável com nome .pdf é recusado', async () => {
      const exe = Buffer.from('MZ\x90\x00 programa malicioso');
      expect((await enviar(p.a!.token, { tipo: 'NOTA_FISCAL' }, exe, 'nf.pdf')).status).toBe(422);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      expect((await enviar(p.a!.token, { tipo: 'NOTA_FISCAL' }, png, 'foto.png')).status).toBe(201);
    });

    it('RH envia o comprovante para o colaborador; ele vê e baixa; outros não; o RH aprova/reprova', async () => {
      const comp = await enviar(p.rh!.token, { tipo: 'COMPROVANTE_PAGAMENTO', colaboradorId: p.a!.colabId, competencia: '2026-10' }, PDF, 'comprovante.pdf');
      expect(comp.status).toBe(201);
      const id = comp.body.data.id as string;

      const minhaLista = await get('/documentos?limit=50', p.a!.token);
      expect(minhaLista.body.data.map((d: { id: string }) => d.id)).toContain(id);
      expect(minhaLista.body.data.every((d: { colaboradorId: string }) => d.colaboradorId === p.a!.colabId)).toBe(true);

      const baixar = await get(`/documentos/${id}/arquivo`, p.a!.token);
      expect(baixar.status).toBe(200);
      expect(baixar.headers['content-type']).toBe('application/pdf');
      expect(baixar.headers['content-disposition']).toContain('attachment');
      expect(baixar.headers['x-content-type-options']).toBe('nosniff');
      expect((await get(`/documentos/${id}/arquivo`, p.b!.token)).status).toBe(404); // de outra pessoa
      expect((await get(`/documentos/${id}/arquivo`, p.gestor!.token)).status).toBe(404); // nem o gestor
      expect((await get(`/documentos/${id}/arquivo`, p.ceo!.token)).status).toBe(200);

      const todos = await get('/documentos?limit=50', p.rh!.token);
      expect(todos.body.meta.total).toBeGreaterThanOrEqual(3);

      expect((await request(app).patch(api(`/documentos/${id}/status`)).set('Authorization', p.a!.token).send({ status: 'APROVADO' })).status).toBe(403);
      expect((await request(app).patch(api(`/documentos/${id}/status`)).set('Authorization', p.rh!.token).send({ status: 'REPROVADO' })).status).toBe(422); // exige motivo
      const rep = await request(app).patch(api(`/documentos/${id}/status`)).set('Authorization', p.rh!.token).send({ status: 'REPROVADO', motivo: 'Valor diferente da folha' });
      expect(rep.body.data).toMatchObject({ status: 'REPROVADO', motivoReprovacao: 'Valor diferente da folha' });
    });
  });
});
