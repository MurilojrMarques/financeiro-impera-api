import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import type { EstadoOrigem } from '../../src/integrations/rh-mysql/rh-mysql';
import { hashPassword } from '../../src/modules/auth/password.service';
import { monitorarOrigemRh, type Leitores } from '../../src/modules/rh/rh.monitor';
import { app, login, resetDb, SENHA } from '../helpers/db';

const api = (p: string) => `/api/v1/rh${p}`;

/** Origem simulada: o "sistema do Alexandre". Os testes mexem nela e a API deve perceber. O salário na origem é em REAIS. */
const colab = (id: string, nome: string, salario: number, extra: Record<string, unknown> = {}) => ({
  id, nome, email: `${id}@teste.local`, funcao: 'Editor', cargoBase: 'Editor', departamento: 'Edição', senioridade: 'pl', subnivel: 1,
  salario, inicio: '2026-01-05', demissao: null, gestorId: null, cnpj: '00.000.000/0001-00', ...extra,
});
let estado: Record<string, unknown>;
let salvoEm = new Date('2026-10-26T10:00:00Z');
let origemFora = false;
let lidas = 0;

const origem = (): EstadoOrigem => ({ estado: structuredClone(estado), atualizadoEm: salvoEm, atualizadoPor: 'alexandre', admins: [] });
const leitores: Leitores = {
  marca: async () => {
    if (origemFora) throw new Error('MySQL indisponível (simulado)');
    return { atualizadoEm: salvoEm, atualizadoPor: 'alexandre', tamanho: JSON.stringify(estado).length };
  },
  ler: async () => {
    lidas++;
    return origem();
  },
};
const rodar = (opts: { forcar?: boolean } = {}) => monitorarOrigemRh('job', { ...opts, leitores });
/** Simula o Alexandre salvando uma alteração no sistema dele. */
const salvarNaOrigem = (mutar: () => void): void => {
  mutar();
  salvoEm = new Date(salvoEm.getTime() + 60_000);
};

let rhToken = '';
let gestorToken = '';

describe('RH: espelho e monitoramento da origem (salário só nasce no sistema do Alexandre)', () => {
  beforeAll(async () => {
    await resetDb();
    estado = {
      colaboradores: [colab('g1', 'Gestora Origem', 8000, { funcao: 'Líder', cargoBase: 'Líder' }), colab('c1', 'Carlos Origem', 4000, { gestorId: 'g1' }), colab('c2', 'Dora Origem', 5000, { gestorId: 'g1' })],
      promocoes: [{ id: 'p1', colaboradorId: 'c2', data: '2026-08-01', tipo: 'reajuste', salarioAnterior: 4500, salarioNovo: 5000, cargoAnterior: 'Editor', cargoNovo: 'Editor' }],
      faixasSalariais: { Edição: { Editor: { jr: 2000, pl: 3500 } } },
    };
    // o RH e o gestor consultam (papéis vindos do banco, como em produção)
    const mk = async (chave: string, papel: 'RH' | 'GESTOR', colaboradorId?: string) => {
      await prisma.usuario.create({ data: { email: `${chave}@teste.local`, nome: chave, perfil: 'SEM_FINANCEIRO', rhPapel: papel, colaboradorId: colaboradorId ?? null, senhaHash: await hashPassword(SENHA) } });
      return `Bearer ${(await login(`${chave}@teste.local`)).body.data.accessToken}`;
    };
    rhToken = await mk('rhsync', 'RH');
    await rodar(); // primeira leitura cria os colaboradores
    const g1 = await prisma.rhColaborador.findUniqueOrThrow({ where: { legadoId: 'g1' } });
    gestorToken = await mk('gestorsync', 'GESTOR', g1.id);
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it('a primeira leitura espelha colaboradores (salário em centavos), gestor, histórico e faixas; cada novo vira uma alteração', async () => {
    const c2 = await prisma.rhColaborador.findUniqueOrThrow({ where: { legadoId: 'c2' }, include: { gestor: true, movimentacoes: true } });
    expect(c2).toMatchObject({ nome: 'Dora Origem', salarioCentavos: 500000 });
    expect(c2.gestor?.nome).toBe('Gestora Origem');
    expect(c2.movimentacoes).toHaveLength(1);
    expect(await prisma.rhFaixaSalarial.count()).toBe(2);
    expect(await prisma.rhAlteracao.count({ where: { tipo: 'NOVO_COLABORADOR' } })).toBe(3);
  });

  it('se a origem não mudou, nem lê o JSON (consulta barata); com "forcar" lê e não acha nada novo', async () => {
    const antes = lidas;
    expect(await rodar()).toEqual({ situacao: 'SEM_MUDANCA' });
    expect(lidas).toBe(antes);
    const f = await rodar({ forcar: true });
    expect(f).toMatchObject({ situacao: 'SINCRONIZADO', alteracoes: 0 });
  });

  it('aumento de salário na origem: detectado, com valor antes e depois; o salário aqui acompanha a origem', async () => {
    salvarNaOrigem(() => {
      (estado.colaboradores as { id: string; salario: number }[]).find((c) => c.id === 'c1')!.salario = 4800;
    });
    const r = await rodar();
    expect(r).toMatchObject({ situacao: 'SINCRONIZADO', alteracoes: 1 });
    const alt = await prisma.rhAlteracao.findFirstOrThrow({ where: { tipo: 'SALARIO' } });
    expect(alt).toMatchObject({ campo: 'salario', anterior: '400000', novo: '480000' });
    expect((await prisma.rhColaborador.findUniqueOrThrow({ where: { legadoId: 'c1' } })).salarioCentavos).toBe(480000);
  });

  it('a lista de alterações é só para RH/CEO (traz valores de salário); gestor recebe 403', async () => {
    const r = await request(app).get(api('/alteracoes?tipo=SALARIO')).set('Authorization', rhToken);
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ tipo: 'SALARIO', anterior: '400000', novo: '480000', colaborador: { nome: 'Carlos Origem' } });
    expect((await request(app).get(api('/alteracoes')).set('Authorization', gestorToken)).status).toBe(403);
    expect((await request(app).get(api('/monitoramento')).set('Authorization', gestorToken)).status).toBe(403);
    // o gestor continua usando o resto do módulo (a guarda do monitoramento não pode barrar as demais rotas)
    expect((await request(app).get(api('/colaboradores')).set('Authorization', gestorToken)).status).toBe(200);
  });

  it('a auditoria não guarda valores de salário (o ADMIN lê a auditoria e não pode ver salários)', async () => {
    const logs = await prisma.auditoria.findMany();
    expect(JSON.stringify(logs.map((l) => l.detalhes))).not.toMatch(/480000|400000/);
  });

  it('promoção na origem: vira movimentação e mudança de cargo, e o histórico aparece aqui', async () => {
    salvarNaOrigem(() => {
      const c = (estado.colaboradores as Record<string, unknown>[]).find((x) => x.id === 'c1')!;
      c.salario = 6000;
      c.funcao = 'Editor Sr';
      c.senioridade = 'sr';
      (estado.promocoes as unknown[]).push({ id: 'p2', colaboradorId: 'c1', data: '2026-10-26', tipo: 'promocao', salarioAnterior: 4800, salarioNovo: 6000, cargoAnterior: 'Editor', cargoNovo: 'Editor Sr', senioridadeAnterior: 'pl', senioridadeNova: 'sr' });
    });
    await rodar();
    const tipos = (await prisma.rhAlteracao.findMany({ where: { detectadaEm: { gte: new Date(Date.now() - 60_000) } } })).map((a) => a.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['SALARIO', 'CARGO', 'MOVIMENTACAO']));
    const c1 = await prisma.rhColaborador.findUniqueOrThrow({ where: { legadoId: 'c1' }, include: { movimentacoes: true } });
    expect(c1).toMatchObject({ salarioCentavos: 600000, funcao: 'Editor Sr', senioridade: 'sr' });
    expect(c1.movimentacoes).toHaveLength(1);
  });

  it('o painel de monitoramento mostra a última verificação e as alterações dos últimos 30 dias', async () => {
    const r = await request(app).get(api('/monitoramento')).set('Authorization', rhToken);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ultimoStatus: 'SUCESSO', atrasado: false, origem: { salvaPor: 'alexandre' } });
    expect(r.body.data.alteracoesUltimos30Dias.SALARIO).toBeGreaterThanOrEqual(2);
    expect(r.body.data.inconsistenciasNaOrigem).toEqual([]);
  });

  it('inconsistência na origem (salário atual ≠ último reajuste registrado) é sinalizada: seria um "segundo salário"', async () => {
    salvarNaOrigem(() => {
      (estado.colaboradores as { id: string; salario: number }[]).find((c) => c.id === 'c2')!.salario = 5500; // sem registrar a promoção
    });
    const r = await rodar();
    expect(r).toMatchObject({ situacao: 'SINCRONIZADO', inconsistencias: 1 });
    const m = await request(app).get(api('/monitoramento')).set('Authorization', rhToken);
    expect(m.body.data.inconsistenciasNaOrigem).toHaveLength(1);
    expect(m.body.data.inconsistenciasNaOrigem[0]).toMatchObject({ salarioAtualCentavos: 550000, ultimoReajusteCentavos: 500000 });
  });

  it('a folha do mês aberta acompanha o aumento; a folha fechada nunca é tocada', async () => {
    const hoje = new Date().toISOString().slice(0, 7);
    const comp = await prisma.rhFolhaCompetencia.create({ data: { competencia: hoje } });
    const c1 = await prisma.rhColaborador.findUniqueOrThrow({ where: { legadoId: 'c1' } });
    await prisma.rhFolhaItem.create({ data: { competenciaId: comp.id, colaboradorId: c1.id, salarioMensalCentavos: 600000, diasTrabalhados: 30, salarioCentavos: 600000, totalCentavos: 600000 + 50000, bonusCentavos: 50000 } });
    salvarNaOrigem(() => {
      const c = (estado.colaboradores as { id: string; salario: number }[]).find((x) => x.id === 'c1')!;
      c.salario = 7000;
      (estado.promocoes as unknown[]).push({ id: 'p3', colaboradorId: 'c1', data: '2026-10-27', tipo: 'reajuste', salarioAnterior: 6000, salarioNovo: 7000, cargoAnterior: 'Editor Sr', cargoNovo: 'Editor Sr' });
    });
    const r = await rodar();
    expect(r).toMatchObject({ situacao: 'SINCRONIZADO', folhaRecalculada: 1 });
    const item = await prisma.rhFolhaItem.findFirstOrThrow({ where: { competenciaId: comp.id } });
    expect(item).toMatchObject({ salarioCentavos: 700000, bonusCentavos: 50000, totalCentavos: 750000 }); // o bônus lançado fica
    await prisma.rhFolhaCompetencia.update({ where: { id: comp.id }, data: { status: 'FECHADA' } });
    salvarNaOrigem(() => {
      (estado.colaboradores as { id: string; salario: number }[]).find((x) => x.id === 'c1')!.salario = 7500;
      (estado.promocoes as unknown[]).push({ id: 'p4', colaboradorId: 'c1', data: '2026-10-28', tipo: 'reajuste', salarioAnterior: 7000, salarioNovo: 7500, cargoAnterior: 'Editor Sr', cargoNovo: 'Editor Sr' });
    });
    expect(await rodar()).toMatchObject({ folhaRecalculada: 0 });
    expect((await prisma.rhFolhaItem.findFirstOrThrow({ where: { competenciaId: comp.id } })).salarioCentavos).toBe(700000);
  });

  it('desligamento na origem: registrado, e o login da pessoa é desativado e as sessões encerradas', async () => {
    const c2 = await prisma.rhColaborador.findUniqueOrThrow({ where: { legadoId: 'c2' } });
    await prisma.usuario.create({ data: { email: 'dora@teste.local', nome: 'Dora', perfil: 'SEM_FINANCEIRO', rhPapel: 'COLABORADOR', colaboradorId: c2.id, senhaHash: await hashPassword(SENHA) } });
    const sessao = await login('dora@teste.local');
    expect(sessao.status).toBe(200);
    salvarNaOrigem(() => {
      const c = (estado.colaboradores as Record<string, unknown>[]).find((x) => x.id === 'c2')!;
      c.demissao = '2026-10-28';
      c.motivoDemissao = 'voluntario';
    });
    await rodar();
    expect(await prisma.rhAlteracao.count({ where: { tipo: 'DESLIGAMENTO', colaboradorId: c2.id } })).toBe(1);
    expect((await login('dora@teste.local')).status).toBe(401);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { colaboradorId: c2.id } })).ativo).toBe(false);
  });

  it('origem fora do ar: o erro é registrado, o ciclo seguinte tenta de novo e o painel avisa; ao voltar, normaliza', async () => {
    origemFora = true;
    const r = await rodar();
    expect(r.situacao).toBe('ERRO');
    const m = await request(app).get(api('/monitoramento')).set('Authorization', rhToken);
    expect(m.body.data).toMatchObject({ ultimoStatus: 'ERRO', falhasSeguidas: 1 });
    expect(m.body.data.ultimoErro).toContain('indisponível');
    expect(await prisma.rhSincronizacao.count({ where: { status: 'ERRO' } })).toBe(1);
    await rodar(); // 2ª falha seguida: não enche a tabela
    expect(await prisma.rhSincronizacao.count({ where: { status: 'ERRO' } })).toBe(1);
    origemFora = false;
    expect((await rodar({ forcar: true })).situacao).toBe('SINCRONIZADO');
    expect((await request(app).get(api('/monitoramento')).set('Authorization', rhToken)).body.data).toMatchObject({ ultimoStatus: 'SUCESSO', falhasSeguidas: 0 });
  });

  it('colaborador que sumiu da origem não é apagado (há histórico de folha): só é avisado, uma vez', async () => {
    salvarNaOrigem(() => {
      estado.colaboradores = (estado.colaboradores as { id: string }[]).filter((c) => c.id !== 'c2');
    });
    await rodar();
    await rodar({ forcar: true });
    expect(await prisma.rhColaborador.count({ where: { legadoId: 'c2' } })).toBe(1);
    expect(await prisma.rhAlteracao.count({ where: { tipo: 'REMOVIDO_DA_ORIGEM' } })).toBe(1);
  });
});
