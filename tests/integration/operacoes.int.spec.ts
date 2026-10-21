import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { GoogleSheetsService } from '../../src/integrations/google-sheets/google-sheets.service';
import { setSyncService } from '../../src/modules/sincronizacao/sincronizacao.routes';
import { SyncService } from '../../src/modules/sincronizacao/sync.service';
import { FakeSheets } from '../helpers/fake-sheets';
import { app, resetDb, resetLimiters, tokenDe } from '../helpers/db';

const api = '/api/v1';
let admin = '';
let financeiro = '';
let analista = '';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 'a'), Buffer.from('\n%%EOF')]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

describe('custos operacionais, anexos e administração', () => {
  let categoriaId = '';
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    financeiro = await tokenDe('FINANCEIRO');
    analista = await tokenDe('ANALISTA');
    const c = await request(app).post(`${api}/custos/categorias`).set('Authorization', financeiro).send({ nome: 'Infraestrutura' });
    categoriaId = c.body.data.id;
  });
  afterAll(closeDatabase);

  it('categorias: cria, impede duplicadas, atualiza', async () => {
    expect((await request(app).post(`${api}/custos/categorias`).set('Authorization', financeiro).send({ nome: 'Infraestrutura' })).status).toBe(409);
    const up = await request(app).patch(`${api}/custos/categorias/${categoriaId}`).set('Authorization', financeiro).send({ nome: 'Infra' });
    expect(up.body.data.nome).toBe('Infra');
    expect((await request(app).get(`${api}/custos/categorias`).set('Authorization', financeiro)).body.data).toHaveLength(1);
  });

  it('lançamento: valida corpo, cria, lista com filtros/paginação, atualiza, resume e remove', async () => {
    const ruim = await request(app).post(`${api}/custos`).set('Authorization', financeiro).send({ descricao: 'x', tipo: 'FIXO', categoriaId, valorCentavos: 12.5, vencimento: '2026-10-15' });
    expect(ruim.status).toBe(422);
    expect((await request(app).post(`${api}/custos`).set('Authorization', financeiro).send({ descricao: 'Servidor', tipo: 'FIXO', categoriaId: '00000000-0000-4000-8000-000000000000', valorCentavos: 100, vencimento: '2026-10-15' })).status).toBe(422);

    const rec = await request(app).post(`${api}/custos/recorrencias`).set('Authorization', financeiro).send({ periodicidade: 'MENSAL', inicio: '2026-10-05' });
    expect(rec.status).toBe(201);
    const c1 = await request(app).post(`${api}/custos`).set('Authorization', financeiro).send({
      descricao: 'Servidor VPS', tipo: 'FIXO', categoriaId, recorrenciaId: rec.body.data.id, valorCentavos: 15000, vencimento: '2026-10-05', observacao: 'contrato anual',
    });
    expect(c1.status).toBe(201);
    expect(c1.body.data).toMatchObject({ valorCentavos: 15000, statusPagamento: 'PENDENTE', categoria: { nome: 'Infra' } });
    const c2 = await request(app).post(`${api}/custos`).set('Authorization', financeiro).send({ descricao: 'Freelancer', tipo: 'VARIAVEL', categoriaId, valorCentavos: 50000, vencimento: '2026-11-20', statusPagamento: 'PAGO' });

    const lista = await request(app).get(`${api}/custos?de=2026-11-01&ate=2026-11-30`).set('Authorization', financeiro);
    expect(lista.body.meta.total).toBe(1);
    expect(lista.body.data[0].descricao).toBe('Freelancer');
    expect((await request(app).get(`${api}/custos?status=PAGO`).set('Authorization', financeiro)).body.meta.total).toBe(1);
    expect((await request(app).get(`${api}/custos?busca=servidor`).set('Authorization', financeiro)).body.meta.total).toBe(1);

    // resumo de novembro: a recorrência mensal (base 05/10) projeta 05/11 + o lançamento avulso de 20/11
    const resumo = (await request(app).get(`${api}/custos/resumo?de=2026-11-01&ate=2026-11-30`).set('Authorization', financeiro)).body.data;
    expect(resumo.totalLancamentosCentavos).toBe(65000);
    expect(resumo.projetadas).toBe(1);
    expect(resumo.pagoCentavos).toBe(50000);
    expect(resumo.pendenteCentavos).toBe(15000);

    const upd = await request(app).patch(`${api}/custos/${c2.body.data.id}`).set('Authorization', financeiro).send({ statusPagamento: 'CANCELADO' });
    expect(upd.body.data.statusPagamento).toBe('CANCELADO');
    expect((await request(app).get(`${api}/custos/resumo?de=2026-11-01&ate=2026-11-30`).set('Authorization', financeiro)).body.data.totalLancamentosCentavos).toBe(15000);
    expect((await request(app).delete(`${api}/custos/${c2.body.data.id}`).set('Authorization', financeiro)).status).toBe(204);
    expect((await request(app).get(`${api}/custos/${c2.body.data.id}`).set('Authorization', financeiro)).status).toBe(404);
    expect((await request(app).get(`${api}/custos`).set('Authorization', analista)).status).toBe(403);
  });

  it('anexos: valida o MIME REAL (extensão .pdf com conteúdo de texto é rejeitada), limita tamanho e guarda em área privada', async () => {
    const custo = (await request(app).post(`${api}/custos`).set('Authorization', financeiro).send({ descricao: 'Nota fiscal', tipo: 'VARIAVEL', categoriaId, valorCentavos: 9900, vencimento: '2026-10-10' })).body.data;
    const url = `${api}/custos/${custo.id}/anexos`;

    const falso = await request(app).post(url).set('Authorization', financeiro).attach('arquivo', Buffer.from('<?php echo 1; ?> não sou PDF'), { filename: 'nota.pdf', contentType: 'application/pdf' });
    expect(falso.status).toBe(422);
    const exe = await request(app).post(url).set('Authorization', financeiro).attach('arquivo', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), { filename: 'x.png', contentType: 'image/png' });
    expect(exe.status).toBe(422);
    const grande = await request(app).post(url).set('Authorization', financeiro).attach('arquivo', Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]), { filename: 'grande.pdf' });
    expect(grande.status).toBe(400);
    expect((await request(app).post(url).set('Authorization', financeiro)).status).toBe(422); // sem arquivo

    const ok = await request(app).post(url).set('Authorization', financeiro).attach('arquivo', PDF, { filename: '../../etc/nota fiscal.pdf', contentType: 'text/plain' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ mime: 'application/pdf' });
    expect(ok.body.data.nomeOriginal).not.toContain('..');
    expect((await request(app).post(url).set('Authorization', financeiro).attach('arquivo', PNG, { filename: 'comprovante.png' })).status).toBe(201);

    const lista = (await request(app).get(url).set('Authorization', financeiro)).body.data;
    expect(lista).toHaveLength(2);
    expect(JSON.stringify(lista)).not.toMatch(/caminho|storage/); // caminho interno nunca é exposto

    // arquivo gravado fora de qualquer diretório público e inacessível sem autenticação/perfil
    const reg = await prisma.anexoCusto.findFirst({ where: { id: ok.body.data.id } });
    const abs = path.resolve(process.env.UPLOAD_DIR!, reg!.caminho);
    expect(existsSync(abs)).toBe(true);
    expect((await request(app).get(`${api}/custos/${custo.id}/anexos/${ok.body.data.id}/download`)).status).toBe(401);
    expect((await request(app).get(`${api}/custos/${custo.id}/anexos/${ok.body.data.id}/download`).set('Authorization', analista)).status).toBe(403);
    const dl = await request(app).get(`${api}/custos/${custo.id}/anexos/${ok.body.data.id}/download`).set('Authorization', financeiro);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cache-control']).toMatch(/no-store/);
    expect((await request(app).get(`/storage/${reg!.caminho}`)).status).toBe(404); // nada é servido estaticamente
    expect((await request(app).get(`/${reg!.caminho}`)).status).toBe(404);
    // anexo de outro custo não é acessível pelo id do anexo com id de custo errado
    const outro = (await request(app).post(`${api}/custos`).set('Authorization', financeiro).send({ descricao: 'Outro', tipo: 'FIXO', categoriaId, valorCentavos: 1, vencimento: '2026-10-10' })).body.data;
    expect((await request(app).get(`${api}/custos/${outro.id}/anexos/${ok.body.data.id}/download`).set('Authorization', financeiro)).status).toBe(404);

    expect((await request(app).delete(`${url}/${ok.body.data.id}`).set('Authorization', financeiro)).status).toBe(204);
    expect(existsSync(abs)).toBe(false);
    expect(await prisma.auditoria.count({ where: { acao: 'custo.anexo_adicionado' } })).toBe(2);
  });

  it('regras de custo: valida parâmetros por tipo e vigência; regra por unidade fica indisponível', async () => {
    const base = { nome: 'Frete', metodologia: 'Valor médio por pedido enviado', vigenteDe: '2026-01-01T00:00:00-03:00' };
    expect((await request(app).post(`${api}/financeiro/regras-custo`).set('Authorization', financeiro).send({ ...base, tipo: 'VALOR_POR_PEDIDO' })).status).toBe(422);
    expect((await request(app).post(`${api}/financeiro/regras-custo`).set('Authorization', financeiro).send({ ...base, tipo: 'PERCENTUAL_RECEITA' })).status).toBe(422);
    const un = await request(app).post(`${api}/financeiro/regras-custo`).set('Authorization', financeiro).send({ ...base, nome: 'Por unidade', tipo: 'VALOR_POR_UNIDADE', valorCentavos: 800 });
    expect(un.status).toBe(201);
    const dre = (await request(app).get(`${api}/financeiro/dre?de=2026-10-01&ate=2026-10-31`).set('Authorization', financeiro)).body.data;
    expect(dre.custos.regrasIndisponiveis[0].motivo).toMatch(/unidades/);
    const pat = await request(app).patch(`${api}/financeiro/regras-custo/${un.body.data.id}`).set('Authorization', financeiro).send({ ativa: false });
    expect(pat.body.data.ativa).toBe(false);
  });

  it('regras de classificação: CRUD só ADMIN, versão incrementa, tudo auditado', async () => {
    const corpo = { nome: 'E-mail', campo: 'ORIGEM', operador: 'IGUAL', valor: 'EMAIL', grupo: 'BACKEND_OUTROS', canal: 'E-mail' };
    expect((await request(app).post(`${api}/classificacoes/regras`).set('Authorization', financeiro).send(corpo)).status).toBe(403);
    const c = await request(app).post(`${api}/classificacoes/regras`).set('Authorization', admin).send(corpo);
    expect(c.status).toBe(201);
    expect(c.body.data.versao).toBe(1);
    const p = await request(app).patch(`${api}/classificacoes/regras/${c.body.data.id}`).set('Authorization', admin).send({ valor: 'E-MAIL MKT' });
    expect(p.body.data).toMatchObject({ versao: 2, valor: 'E-MAIL MKT' });
    expect((await request(app).post(`${api}/classificacoes/regras`).set('Authorization', admin).send({ ...corpo, grupo: 'INVENTADO' })).status).toBe(422);
    expect((await request(app).delete(`${api}/classificacoes/regras/${c.body.data.id}`).set('Authorization', admin)).status).toBe(204);
    const acoes = (await prisma.auditoria.findMany({ where: { acao: { startsWith: 'classificacao.' } } })).map((a) => a.acao).sort();
    expect(acoes).toEqual(['classificacao.regra_atualizada', 'classificacao.regra_criada', 'classificacao.regra_removida']);
  });

  it('reclassificação em segundo plano move vendas para o grupo da nova regra', async () => {
    await prisma.venda.create({
      data: { pedido: 'R1', grupo: 'NAO_CLASSIFICADA', tipoVenda: 'OUTRO', status: 'PAGO', origem: 'WhatsApp', valorVendaCentavos: 1000, comissaoFonte: 'AUSENTE', fonteVerdade: 'HISTORICO', hashConteudo: 'x', pagoEm: new Date() },
    });
    await request(app).post(`${api}/classificacoes/regras`).set('Authorization', admin).send({ nome: 'WhatsApp', campo: 'ORIGEM', operador: 'IGUAL', valor: 'whatsapp', grupo: 'BACKEND_OUTROS', canal: 'WhatsApp' });
    for (let i = 0; i < 40; i++) {
      if ((await prisma.venda.findUnique({ where: { pedido: 'R1' } }))!.grupo === 'BACKEND_OUTROS') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await prisma.venda.findUnique({ where: { pedido: 'R1' } })).toMatchObject({ grupo: 'BACKEND_OUTROS' });
  });
});

/** Espera até existirem `finalizadas` execuções concluídas (acumulado) e nenhuma em andamento: sem corrida com o início assíncrono. */
async function aguardarFimDasSincronizacoes(finalizadas: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [rodando, prontas] = await Promise.all([
      prisma.sincronizacao.count({ where: { status: 'EXECUTANDO' } }),
      prisma.sincronizacao.count({ where: { status: { not: 'EXECUTANDO' } } }),
    ]);
    if (rodando === 0 && prontas >= finalizadas) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sincronização não terminou a tempo');
}

describe('integração: disparo manual, status e erros', () => {
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    financeiro = await tokenDe('FINANCEIRO');
    analista = await tokenDe('ANALISTA');
  });
  afterAll(async () => {
    setSyncService(null);
    await closeDatabase();
  });

  it('sem Google configurado: 503 sanitizado (sem vazar caminhos/credenciais); só ADMIN dispara', async () => {
    expect((await request(app).post(`${api}/integracoes/sheets/sincronizar`).set('Authorization', financeiro).send({})).status).toBe(403);
    const r = await request(app).post(`${api}/integracoes/sheets/sincronizar`).set('Authorization', admin).send({});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('UNAVAILABLE');
  });

  it('disparo manual: 202, executa, e segundo disparo durante a execução recebe 409', async () => {
    const sheets = new FakeSheets();
    for (let i = 1; i <= 3; i++) sheets.addEvento({ recebido_em: '05/10/2026 10:00:00', pago_em: '05/10/2026 10:00:00', evento: 'pagamento', pedido: `M${i}`, tipo: 'front', valor_sem_juros: '10,00' });
    sheets.delayMs = 300;
    setSyncService(new SyncService(new GoogleSheetsService(sheets), { batchSize: 1, lookbackRows: 0 }));
    const a = await request(app).post(`${api}/integracoes/sheets/sincronizar`).set('Authorization', admin).send({ fonte: 'EVENTOS' });
    expect(a.status).toBe(202);
    const b = await request(app).post(`${api}/integracoes/sheets/reconciliar`).set('Authorization', admin).send({ fonte: 'EVENTOS' });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('SYNC_EM_ANDAMENTO');
    await aguardarFimDasSincronizacoes(1);
    expect(await prisma.venda.count()).toBe(3);

    const exec = (await request(app).get(`${api}/integracoes/sheets/execucoes`).set('Authorization', admin)).body;
    expect(exec.data[0]).toMatchObject({ fonte: 'EVENTOS', status: 'SUCESSO', inseridos: 3, disparadaPor: expect.stringMatching(/^manual:/) });
    expect((await request(app).get(`${api}/integracoes/sheets/execucoes`).set('Authorization', analista)).status).toBe(403);
    expect(await prisma.auditoria.count({ where: { acao: 'integracao.sincronizar' } })).toBe(1);
  });

  it('erros e fontes: expostos só ao ADMIN, sem credenciais nem IDs da planilha', async () => {
    const sheets = new FakeSheets();
    sheets.addEvento({ recebido_em: '05/10/2026 10:00:00', evento: 'pagamento', pedido: 'E1', valor_sem_juros: 'lixo' });
    setSyncService(new SyncService(new GoogleSheetsService(sheets)));
    await resetLimiters();
    const disparo = await request(app).post(`${api}/integracoes/sheets/sincronizar`).set('Authorization', admin).send({ fonte: 'EVENTOS' });
    expect(disparo.status).toBe(202);
    await aguardarFimDasSincronizacoes(2);
    const erros = await request(app).get(`${api}/integracoes/sheets/erros`).set('Authorization', admin);
    expect(erros.body.data[0]).toMatchObject({ fonte: 'EVENTOS', codigo: 'LINHA_INVALIDA' });
    const fontes = await request(app).get(`${api}/integracoes/sheets/fontes`).set('Authorization', admin);
    expect(fontes.status).toBe(200);
    expect(JSON.stringify([erros.body, fontes.body])).not.toMatch(/private_key|client_email|GOOGLE_SHEET_ID|spreadsheetId|lixo/);
    expect((await request(app).get(`${api}/integracoes/sheets/erros`).set('Authorization', financeiro)).status).toBe(403);
  });

  it('métricas e auditoria exigem ADMIN', async () => {
    expect((await request(app).get(`${api}/admin/metricas`)).status).toBe(401);
    expect((await request(app).get(`${api}/admin/metricas`).set('Authorization', financeiro)).status).toBe(403);
    const m = await request(app).get(`${api}/admin/metricas`).set('Authorization', admin);
    expect(m.status).toBe(200);
    expect(m.body.data.banco.vendas).toBe(3);
  });
});
