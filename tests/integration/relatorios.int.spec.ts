import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { GoogleSheetsService } from '../../src/integrations/google-sheets/google-sheets.service';
import { SyncService } from '../../src/modules/sincronizacao/sync.service';
import { FakeSheets } from '../helpers/fake-sheets';
import { app, resetDb, tokenDe } from '../helpers/db';

/**
 * Dataset sintético (sem dados pessoais) com resultados calculados À MÃO.
 *
 * Pagamentos em out/2026 (valor_sem_juros):           bruto = 1.472,00 (10 pedidos)
 *   P1 front A 297 | P2 upsell A 97 | P3 call center A 197 | P4 afiliado André 297 | P5 afiliado ANDRE (B) 197
 *   P6 sem tipo B 50 | P9 afiliado "Andre Pinheiro Jr" B 80 | P10 front Loja X1 150 | P11 downsell A 47 | H1 SMS (histórico) 60
 * Perdas: P1 estorno 12/10 + chargeback 20/10 (integral, UMA perda de 297) ; P7 (paga em set) estornada 03/10: 100
 *
 * MOVIMENTACAO out : 1.472 − (297 + 100) = 1.075,00
 *   FRONT 591−397=194 | BACKEND_OUTROS 60 | CALL_CENTER 197 | AFILIADO 574 | NAO_CLASSIFICADA 50  (soma 1.075)
 * APROVADAS   out : 1.472 − 297 = 1.175,00 (9 pedidos)   FRONT 294 | BO 60 | CC 197 | AF 574 | NC 50
 */
const pagamento = (pedido: string, extra: Record<string, string> = {}) => ({
  recebido_em: '05/10/2026 10:00:00', pago_em: '05/10/2026 10:00:00', evento: 'pagamento', pedido, tipo: 'front', loja: 'Loja A',
  produto: 'Kit 3', valor_total: '310,00', valor_sem_juros: '297,00', comissao: '', comissao_fonte: '', metodo: 'cartao', parcelas: '3', ...extra,
});

let admin = '';
let financeiro = '';
let analista = '';
let leitura = '';
const Q = 'de=2026-10-01&ate=2026-10-31';
const get = (p: string, auth = admin) => request(app).get(`/api/v1${p}`).set('Authorization', auth);

describe('relatórios financeiros — valores calculados vs esperados', () => {
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    financeiro = await tokenDe('FINANCEIRO');
    analista = await tokenDe('ANALISTA');
    leitura = await tokenDe('LEITURA');

    await prisma.regraClassificacao.create({ data: { nome: 'SMS é back-end', campo: 'ORIGEM', operador: 'IGUAL', valor: 'SMS', grupo: 'BACKEND_OUTROS', canal: 'SMS' } });
    await prisma.configuracaoFinanceira.create({ data: { chave: 'x1.criterio', valor: { campo: 'LOJA', operador: 'IGUAL', valor: 'Loja X1' } } });

    const sheets = new FakeSheets();
    const e = (f: Record<string, string>) => sheets.addEvento(f);
    e(pagamento('P1', { comissao: '100,00', comissao_fonte: 'pagah' }));
    e(pagamento('P2', { tipo: 'upsell', pago_em: '06/10/2026 10:00:00', recebido_em: '06/10/2026 10:00:00', valor_sem_juros: '97,00', valor_total: '97,00' }));
    e(pagamento('P3', { tipo: 'call center', pago_em: '07/10/2026 10:00:00', recebido_em: '07/10/2026 10:00:00', valor_sem_juros: '197,00' }));
    e(pagamento('P4', { afiliado: 'André Pinheiro', pago_em: '08/10/2026 10:00:00', recebido_em: '08/10/2026 10:00:00', comissao: '120,00', comissao_fonte: 'pagah' }));
    e(pagamento('P5', { afiliado: 'ANDRE PINHEIRO', loja: 'Loja B', pago_em: '09/10/2026 10:00:00', recebido_em: '09/10/2026 10:00:00', valor_sem_juros: '197,00' }));
    e(pagamento('P6', { tipo: '', loja: 'Loja B', pago_em: '10/10/2026 10:00:00', recebido_em: '10/10/2026 10:00:00', valor_sem_juros: '50,00' }));
    e(pagamento('P7', { pago_em: '20/09/2026 10:00:00', recebido_em: '20/09/2026 10:00:00', valor_sem_juros: '100,00' }));
    e(pagamento('P8', { teste: 'true' }));
    e(pagamento('P9', { afiliado: 'Andre Pinheiro Jr', loja: 'Loja B', pago_em: '11/10/2026 10:00:00', recebido_em: '11/10/2026 10:00:00', valor_sem_juros: '80,00' }));
    e(pagamento('P10', { loja: 'Loja X1', pago_em: '12/10/2026 10:00:00', recebido_em: '12/10/2026 10:00:00', valor_sem_juros: '150,00', comissao: '50,00', comissao_fonte: 'pagah' }));
    e(pagamento('P11', { produto: '(Downsell) Kit 1', pago_em: '13/10/2026 10:00:00', recebido_em: '13/10/2026 10:00:00', valor_sem_juros: '47,00' }));
    e(pagamento('P1', { evento: 'estorno', recebido_em: '12/10/2026 09:00:00' }));
    e(pagamento('P1', { evento: 'chargeback', recebido_em: '20/10/2026 09:00:00' }));
    e(pagamento('P7', { evento: 'estorno', pago_em: '20/09/2026 10:00:00', recebido_em: '03/10/2026 09:00:00', valor_sem_juros: '100,00' }));
    sheets.addHistorico({
      'Número do Pedido': 'H1', Status: 'Pago', 'Data de Criação': '14/10/2026 09:00:00', 'Data de Pagamento': '14/10/2026 10:00:00',
      'Tipo de Venda': 'front', Origem: 'SMS', Loja: 'Loja A', Produto: 'Kit SMS', 'Valor Total': '60,00', 'Valor sem Juros': '60,00', Comissão: '10,00',
    });

    const sync = new SyncService(new GoogleSheetsService(sheets), { batchSize: 4, lookbackRows: 3 });
    for (const r of await sync.executar(['HISTORICO', 'EVENTOS', 'REDTRACK'], 'INICIAL')) expect(r.status, r.erro).toMatch(/SUCESSO|PARCIAL/);

    // custos (via API, como o dashboard faria)
    const cat = await request(app).post('/api/v1/custos/categorias').set('Authorization', financeiro).send({ nome: 'Ferramentas' });
    await request(app).post('/api/v1/custos').set('Authorization', financeiro).send({
      descricao: 'Plataforma de discagem', tipo: 'FIXO', categoriaId: cat.body.data.id, grupo: 'CALL_CENTER', valorCentavos: 10000, vencimento: '2026-10-15',
    });
    await request(app).post('/api/v1/financeiro/regras-custo').set('Authorization', financeiro).send({
      nome: 'Taxa de gateway', tipo: 'PERCENTUAL_RECEITA', percentualBps: 1000, vigenteDe: '2026-01-01T00:00:00-03:00', metodologia: 'Percentual sobre a receita líquida do período',
    });
  });
  afterAll(closeDatabase);

  it('classificação: grupos corretos e motivo auditável', async () => {
    const g = async (p: string) => (await prisma.venda.findUnique({ where: { pedido: p } }))!;
    expect((await g('P1')).grupo).toBe('FRONT');
    expect((await g('P2'))).toMatchObject({ grupo: 'FRONT', tipoVenda: 'UPSELL' });
    expect((await g('P11'))).toMatchObject({ grupo: 'FRONT', tipoVenda: 'DOWNSELL' });
    expect((await g('P3')).grupo).toBe('CALL_CENTER');
    expect((await g('P4')).grupo).toBe('AFILIADO');
    expect((await g('P6')).grupo).toBe('NAO_CLASSIFICADA');
    expect((await g('H1'))).toMatchObject({ grupo: 'BACKEND_OUTROS' });
    expect((await g('H1')).classificacaoRegraId).not.toBeNull();
    expect(await prisma.venda.findUnique({ where: { pedido: 'P8' } })).toBeNull(); // teste ignorado
  });

  it('receitas por grupo: exclusivos, soma = total, backendTotal = backendOutros + callCenter e NÃO entra na soma geral', async () => {
    const r = await get(`/dashboard/receitas-por-grupo?${Q}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.grupos.front.receitaCentavos).toBe(19400);
    expect(d.grupos.backendOutros.receitaCentavos).toBe(6000);
    expect(d.grupos.callCenter.receitaCentavos).toBe(19700);
    expect(d.grupos.afiliados.receitaCentavos).toBe(57400);
    expect(d.grupos.naoClassificadas.receitaCentavos).toBe(5000);
    expect(d.geral.receitaCentavos).toBe(107500);
    expect(d.backendTotal.receitaCentavos).toBe(25700);
    const soma = Object.values(d.grupos as Record<string, { receitaCentavos: number }>).reduce((s, g) => s + g.receitaCentavos, 0);
    expect(soma).toBe(d.geral.receitaCentavos); // sem dupla contagem
    expect(soma + d.backendTotal.receitaCentavos).not.toBe(d.geral.receitaCentavos);
    expect(r.body.meta).toMatchObject({ criterioFinanceiro: 'MOVIMENTACAO', timezone: 'America/Sao_Paulo', periodo: { de: '2026-10-01', ate: '2026-10-31' } });
  });

  it('distribuição de receitas soma 100%', async () => {
    const d = (await get(`/dashboard/distribuicao-receitas?${Q}`)).body.data;
    const total = d.distribuicao.reduce((s: number, x: { participacaoPercentual: number }) => s + x.participacaoPercentual, 0);
    expect(total).toBeGreaterThan(99.9);
    expect(total).toBeLessThan(100.1);
    expect(d.totalCentavos).toBe(107500);
  });

  it('critério MOVIMENTACAO: bruto, perdas reconhecidas na data do evento, líquido, pedidos e ticket', async () => {
    const d = (await get(`/vendas/resumo?${Q}&modo=MOVIMENTACAO`)).body.data;
    expect(d).toMatchObject({
      pedidos: 10, brutoCentavos: 147200, receitaCentavos: 107500,
      // P7 (estorno, 100) + P1 (estorno e chargeback integrais => conta UMA vez, como chargeback: 297)
      estornosCentavos: 10000, estornosQtd: 1, chargebacksCentavos: 29700, chargebacksQtd: 1, ticketMedioCentavos: 14720,
    });
  });

  it('critério APROVADAS: status atual dos pedidos pagos no período (pedido integralmente perdido sai; perda de pedido de setembro não entra)', async () => {
    const r = await get(`/vendas/resumo?${Q}&modo=APROVADAS`);
    expect(r.body.meta.criterioFinanceiro).toBe('APROVADAS');
    expect(r.body.data).toMatchObject({ pedidos: 9, brutoCentavos: 147200, receitaCentavos: 117500, estornosCentavos: 0, estornosQtd: 0, chargebacksCentavos: 29700, chargebacksQtd: 1, ticketMedioCentavos: 13056 });
    // os dois critérios nunca se misturam: mesmos dados, números diferentes, metodologia explícita
    expect(r.body.meta.metodologia).toMatch(/STATUS ATUAL/);
  });

  it('estorno + chargeback do mesmo pedido: uma perda só (297), atribuída ao chargeback; ambos preservados', async () => {
    const d = (await get(`/reembolsos/resumo?${Q}`)).body.data;
    expect(d.estornosCentavos).toBe(10000);
    expect(d.chargebacksCentavos).toBe(29700);
    expect(d.perdaTotalCentavos).toBe(39700);
    expect(d.pedidosComEstornoEChargeback).toBe(1);
    expect(d.limitacoes.join(' ')).toMatch(/Pix/);
    const c = (await get('/vendas/P1/conciliacao')).body.data;
    expect(c.eventos.map((e: { tipo: string }) => e.tipo).sort()).toEqual(['CHARGEBACK', 'ESTORNO', 'PAGAMENTO']);
    expect(c.perda).toMatchObject({ centavos: 29700, tipo: 'CHARGEBACK', status: 'CHARGEBACK' });
    expect(c.comissao.fonte).toBe('PAGAH');
    // a coluna "comissão" da planilha é o líquido a receber da Pagah (não é comissão)
    expect(c.liquidoReceber).toMatchObject({ centavos: 10000, fonte: 'PAGAH' });
    const vendasP1 = (await get(`/vendas?${Q}&limit=50`)).body.data as { pedido: string; liquidoReceberCentavos: number | null }[];
    expect(vendasP1.find((v) => v.pedido === 'P1')?.liquidoReceberCentavos).toBe(10000);
    const lista = (await get(`/reembolsos/estornos?${Q}`)).body;
    expect(lista.data.map((v: { pedido: string }) => v.pedido)).toEqual(['P7']);
    const cb = (await get(`/reembolsos/chargebacks?${Q}`)).body.data;
    expect(cb.map((v: { pedido: string }) => v.pedido)).toEqual(['P1']);
    // P1 (perda em 20/10, dia do chargeback) NÃO aparece como estorno
    expect((await get(`/reembolsos?${Q}`)).body.meta.total).toBe(2);
  });

  it('comissão: só o Call Center tem fórmula (20% do vendido); a coluna comissão da planilha não é usada; demais grupos = 0', async () => {
    const d = (await get(`/vendas/resumo?${Q}`)).body.data;
    expect(d.comissaoCentavos).toBe(3940); // 20% da receita vendida pelo Call Center
    expect(d.pedidosSemComissao).toBe(0);
    expect(d.x1ComissaoRealCentavos).toBe(0);
    expect(d.alertas.map((a: { codigo: string }) => a.codigo)).not.toContain('COMISSAO_AUSENTE');

    const lista = (await get(`/vendas?${Q}&limit=50`, analista)).body.data as { grupo: string; valorVendaCentavos: number; comissaoCentavos: number }[];
    for (const v of lista) expect(v.comissaoCentavos).toBe(v.grupo === 'CALL_CENTER' ? Math.round(v.valorVendaCentavos * 0.2) : 0);
  });

  it('comissão do Call Center é 20% do valor LÍQUIDO (sem juros − estornos), nos dois critérios', async () => {
    const cc = await prisma.venda.findFirst({ where: { grupo: 'CALL_CENTER', pagoEm: { not: null }, perdaCentavos: 0 } });
    expect(cc).toBeTruthy();
    const perda = Math.floor(cc!.valorVendaCentavos / 2);
    await prisma.venda.update({ where: { id: cc!.id }, data: { perdaCentavos: perda, perdaTipo: 'ESTORNO', perdaEm: cc!.pagoEm } });
    try {
      for (const modo of ['MOVIMENTACAO', 'APROVADAS']) {
        const r = (await get(`/call-center/resumo?${Q}&modo=${modo}`, financeiro)).body.data;
        expect(Math.abs(r.comissaoCentavos - r.receitaCentavos * 0.2), modo).toBeLessThanOrEqual(2); // 20% da receita líquida (±arredondamento)
      }
      const venda = (await get(`/vendas?${Q}&limit=50`, analista)).body.data.find((v: { pedido: string }) => v.pedido === cc!.pedido);
      expect(venda.comissaoCentavos).toBe(Math.round((cc!.valorVendaCentavos - perda) * 0.2));
    } finally {
      // devolve o pedido ao estado original: os testes seguintes compartilham os mesmos dados
      await prisma.venda.update({ where: { id: cc!.id }, data: { perdaCentavos: cc!.perdaCentavos, perdaTipo: cc!.perdaTipo, perdaEm: cc!.perdaEm } });
    }
  });

  it('comissão da Recuperação = (faturamento líquido × 0,70) × 5%', async () => {
    const v = await prisma.venda.findFirst({ where: { grupo: 'FRONT', pagoEm: { not: null }, perdaCentavos: 0 } });
    expect(v).toBeTruthy();
    // com um estorno de metade: a comissão é sobre o faturamento líquido
    await prisma.venda.update({ where: { id: v!.id }, data: { grupo: 'RECUPERACAO', perdaCentavos: Math.floor(v!.valorVendaCentavos / 2), perdaTipo: 'ESTORNO', perdaEm: v!.pagoEm } });
    try {
      const r = (await get(`/recuperacao/resumo?${Q}`, financeiro)).body.data;
      expect(r.receitaCentavos).toBeGreaterThan(0);
      expect(Math.abs(r.comissaoCentavos - r.receitaCentavos * 0.7 * 0.05)).toBeLessThanOrEqual(2);
      const item = (await get(`/vendas?${Q}&limit=50`, analista)).body.data.find((x: { pedido: string }) => x.pedido === v!.pedido);
      expect(item.comissaoCentavos).toBe(Math.round((v!.valorVendaCentavos - Math.floor(v!.valorVendaCentavos / 2)) * 0.035));
    } finally {
      await prisma.venda.update({ where: { id: v!.id }, data: { grupo: v!.grupo, perdaCentavos: v!.perdaCentavos, perdaTipo: v!.perdaTipo, perdaEm: v!.perdaEm } }); // os testes seguintes compartilham os dados
    }
  });

  it('afiliados: identificados pelo nome (equivalências unidas, parecidos separados), com faturamento, comissão e reembolsos', async () => {
    const r = await get(`/afiliados?${Q}`);
    const items = r.body.data as { id: string; nome: string; pedidos: number; faturamentoCentavos: number; comissaoCentavos: number; reembolsosCentavos: number; ticketMedioCentavos: number }[];
    expect(items).toHaveLength(2);
    const andre = items.find((a) => a.nome === 'André Pinheiro')!;
    // comissaoCentavos = comissão do AFILIADO (ainda sem fonte/regra = 0); a da operação (Impera) vem separada
    expect(andre).toMatchObject({ pedidos: 2, faturamentoCentavos: 49400, comissaoCentavos: 0, comissaoOperacaoCentavos: 0, reembolsosCentavos: 0, ticketMedioCentavos: 24700 });
    expect(items.find((a) => a.nome === 'Andre Pinheiro Jr')).toMatchObject({ pedidos: 1, faturamentoCentavos: 8000 });
    expect(r.body.meta.total).toBe(2);

    const filtrado = (await get(`/afiliados?${Q}&nome=pinheiro%20jr`)).body.data;
    expect(filtrado).toHaveLength(1);
    const det = (await get(`/afiliados/${andre.id}/vendas?${Q}`)).body.data.map((v: { pedido: string }) => v.pedido).sort();
    expect(det).toEqual(['P4', 'P5']);
    expect((await get(`/afiliados/${andre.id}/resumo?${Q}`)).body.data).toMatchObject({ pedidos: 2, brutoCentavos: 49400 });
    expect((await get(`/afiliados/ranking?${Q}`)).body.data[0]).toMatchObject({ posicao: 1, nome: 'André Pinheiro' });
  });

  it('afiliado: alias cadastrado incorpora afiliado criado automaticamente com o mesmo nome (explícito, auditado)', async () => {
    const jr = await prisma.afiliado.findFirst({ where: { nome: 'Andre Pinheiro Jr' } });
    const andre = await prisma.afiliado.findFirst({ where: { nome: 'André Pinheiro' } });
    const res = await request(app).post(`/api/v1/afiliados/${andre!.id}/aliases`).set('Authorization', analista).send({ alias: 'Andre Pinheiro Jr' });
    expect(res.status).toBe(403); // só ADMIN
    const ok = await request(app).post(`/api/v1/afiliados/${andre!.id}/aliases`).set('Authorization', admin).send({ alias: 'Andre Pinheiro Jr' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ afiliadoIncorporado: 'Andre Pinheiro Jr', vendasMovidas: 1 });
    expect(await prisma.afiliado.findUnique({ where: { id: jr!.id } })).toBeNull();
    expect((await get(`/afiliados?${Q}`)).body.data).toHaveLength(1);
    expect((await get(`/afiliados?${Q}`)).body.data[0]).toMatchObject({ pedidos: 3, faturamentoCentavos: 57400 });
    expect((await request(app).post(`/api/v1/afiliados/${andre!.id}/aliases`).set('Authorization', admin).send({ alias: 'ANDRE  pinheiro jr' })).status).toBe(409);
    expect(await prisma.auditoria.count({ where: { acao: 'afiliado.alias_criado' } })).toBe(1);
  });

  it('regra de comissão DO AFILIADO preenche só a comissão do afiliado (nunca a da operação) e é sinalizada como estimada', async () => {
    const andre = (await prisma.afiliado.findFirst({ where: { nome: 'André Pinheiro' } }))!;
    const r = await request(app).post(`/api/v1/afiliados/${andre.id}/regras-comissao`).set('Authorization', admin).send({
      valorFixoCentavos: 24000, vigenteDe: '2026-01-01T00:00:00-03:00', fonte: 'Acordo comercial 2026 (planilha de afiliados)',
    });
    expect(r.status).toBe(201);
    const p4 = await prisma.venda.findUnique({ where: { pedido: 'P4' } });
    const p5 = await prisma.venda.findUnique({ where: { pedido: 'P5' } });
    // comissão da OPERAÇÃO intacta (Pagah confirmada / ausente)
    expect(p4).toMatchObject({ comissaoCentavos: 12000, comissaoFonte: 'PAGAH', comissaoAfiliadoCentavos: 24000, comissaoAfiliadoFonte: 'REGRA_AFILIADO' });
    expect(p5).toMatchObject({ comissaoCentavos: null, comissaoFonte: 'AUSENTE', comissaoAfiliadoCentavos: 24000, comissaoAfiliadoFonte: 'REGRA_AFILIADO' });
    const resumo = (await get(`/vendas/resumo?${Q}`)).body.data;
    expect(resumo.comissaoAfiliadoCentavos).toBe(72000); // P4, P5 e P9 (afiliados): 3 × R$ 240
    expect(resumo.comissaoCentavos).toBe(3940); // operação: só Call Center (20%), inalterada pela regra do afiliado
    expect(resumo.alertas.map((a: { codigo: string }) => a.codigo)).toContain('COMISSAO_AFILIADO_ESTIMADA');
    const lista = (await get(`/afiliados?${Q}`)).body.data;
    expect(lista[0]).toMatchObject({ comissaoCentavos: 72000, comissaoOperacaoCentavos: 0 });
  });

  it('front: upsell ÷ compra inicial por loja, sem afiliados', async () => {
    const d = (await get(`/front/conversao-upsell?${Q}`)).body.data;
    expect(d.porLoja).toEqual(expect.arrayContaining([
      { loja: 'Loja A', pedidosUpsell: 1, pedidosCompra: 1, conversaoUpsellPercentual: 100 },
      { loja: 'Loja X1', pedidosUpsell: 0, pedidosCompra: 1, conversaoUpsellPercentual: 0 },
    ]));
    expect(d.porLoja.find((l: { loja: string }) => l.loja === 'Loja B')).toBeUndefined(); // só afiliados/NC: fora do Front
    const resumo = (await get(`/front/resumo?${Q}`)).body.data;
    expect(resumo.receitaCentavos).toBe(19400);
    expect(resumo.unidades.disponivel).toBe(false);
  });

  it('back-end: /backend é só BACKEND_OUTROS; /backend/total traz o agregado; pendências listam NAO_CLASSIFICADA', async () => {
    expect((await get(`/backend/resumo?${Q}`)).body.data.receitaCentavos).toBe(6000);
    const t = (await get(`/backend/total?${Q}`)).body.data;
    expect(t.backendOutros.receitaCentavos).toBe(6000);
    expect(t.callCenter.receitaCentavos).toBe(19700);
    expect(t.backendTotal.receitaCentavos).toBe(25700);
    expect((await get(`/backend/por-canal?${Q}`)).body.data).toEqual([expect.objectContaining({ canal: 'SMS', receitaCentavos: 6000 })]);
    const nc = (await get(`/backend/nao-classificadas?${Q}`)).body.data;
    expect(nc.map((v: { pedido: string }) => v.pedido)).toEqual(['P6']);
    const pend = (await get(`/classificacoes/pendencias?${Q}`)).body.data;
    expect(pend.totalPendentes).toBe(1);
  });

  it('call center: indicadores próprios; custos/margem só para FINANCEIRO/ADMIN; unidades indisponíveis', async () => {
    const d = (await get(`/call-center/resumo?${Q}`, financeiro)).body.data;
    expect(d).toMatchObject({ receitaCentavos: 19700, pedidos: 1, ticketMedioCentavos: 19700, custosCentavos: 10000, sobraOperacionalEstimadaCentavos: 9700, margemPercentual: 49.24 });
    expect(d.unidades.disponivel).toBe(false);
    expect(d.custosPorCategoria).toEqual([expect.objectContaining({ categoria: 'Ferramentas', totalCentavos: 10000 })]);
    const a = (await get(`/call-center/resumo?${Q}`, analista)).body.data;
    expect(a.receitaCentavos).toBe(19700);
    expect(a.custos).toMatchObject({ restrito: true });
    expect(a.sobraOperacionalEstimadaCentavos).toBeUndefined();
    expect((await get(`/call-center/por-metodo?${Q}`)).body.data[0]).toMatchObject({ chave: 'Cartão', pedidos: 1 });
  });

  it('DRE e resultado: custos lançados + regras, resultado e margem', async () => {
    const dre = (await get(`/financeiro/dre?${Q}`, financeiro)).body.data;
    const linha = (c: string) => dre.linhas.find((l: { codigo: string }) => l.codigo === c).valorCentavos;
    expect(linha('RECEITA_BRUTA')).toBe(147200);
    expect(linha('ESTORNOS')).toBe(-10000);
    expect(linha('CHARGEBACKS')).toBe(-29700);
    expect(linha('RECEITA_LIQUIDA')).toBe(107500);
    expect(linha('CUSTOS_LANCADOS')).toBe(-10000);
    expect(linha('CUSTOS_REGRAS')).toBe(-10750); // 10% de 1.075,00
    expect(linha('RESULTADO_OPERACIONAL')).toBe(86750);
    expect(dre.margemOperacionalPercentual).toBe(80.7);
    expect(dre.informativos.observacao).toMatch(/NÃO são deduzidas/);
  });

  it('dashboard: KPIs completos para financeiro; custos/resultado ocultos para LEITURA (que ainda vê receita)', async () => {
    const k = (await get(`/dashboard/kpis?${Q}`, financeiro)).body.data;
    expect(k).toMatchObject({
      receitaCentavos: 107500, receitaFrontCentavos: 19400, receitaBackendOutrosCentavos: 6000, receitaCallCenterCentavos: 19700,
      receitaAfiliadosCentavos: 57400, receitaBackendTotalCentavos: 25700,
      custos: { disponivel: true, custosCentavos: 20750, resultadoOperacionalCentavos: 86750, margemOperacionalPercentual: 80.7 },
    });
    const l = (await get(`/dashboard/kpis?${Q}`, leitura)).body.data;
    expect(l.receitaCentavos).toBe(107500);
    expect(l.custos.disponivel).toBe(false);
    const ind = (await get(`/dashboard/indicadores?${Q}`)).body.data;
    const v = (c: string) => ind.find((i: { codigo: string }) => i.codigo === c);
    expect(v('faturamentoBrutoPago').valor).toBe(147200);
    expect(v('faturamentoLiquidoAjustado').valor).toBe(107500);
    expect(v('receitaAprovadaPainel').valor).toBe(117500);
    expect(v('unidadesVendidas')).toMatchObject({ valor: null, disponivel: false });
  });

  it('comparativo usa o período anterior de mesma duração', async () => {
    const d = (await get(`/dashboard/comparativo?${Q}`)).body.data;
    expect(d.anterior.periodo).toEqual({ de: '2026-08-31', ate: '2026-09-30' });
    expect(d.anterior).toMatchObject({ pedidos: 1, brutoCentavos: 10000, receitaCentavos: 10000 }); // P7 paga em setembro
    expect(d.atual.receitaCentavos).toBe(107500);
    expect(d.variacaoPercentual.receita).toBe(975);
  });

  it('séries por dia/hora/semana somam o total', async () => {
    const dia = (await get(`/vendas/por-dia?${Q}`)).body.data;
    expect(dia.reduce((s: number, x: { receitaCentavos: number }) => s + x.receitaCentavos, 0)).toBe(107500);
    expect(dia.find((x: { periodo: string }) => x.periodo === '2026-10-03').receitaCentavos).toBe(-10000); // estorno de P7 em 03/10
    const hora = (await get(`/vendas/por-hora?${Q}`)).body.data;
    expect(hora.reduce((s: number, x: { pedidos: number }) => s + x.pedidos, 0)).toBe(10);
    const sem = (await get(`/vendas/por-semana?${Q}`)).body.data;
    expect(sem.reduce((s: number, x: { receitaCentavos: number }) => s + x.receitaCentavos, 0)).toBe(107500);
  });

  it('listagem paginada, ordenação por whitelist, filtros e limites; sem dados pessoais nem payload', async () => {
    const r = await get(`/vendas?${Q}&limit=3&page=2&sortBy=valorVendaCentavos&sortOrder=ASC`);
    expect(r.body.meta).toMatchObject({ page: 2, limit: 3, total: 10, totalPages: 4 });
    expect(r.body.data).toHaveLength(3);
    const valores = r.body.data.map((v: { valorVendaCentavos: number }) => v.valorVendaCentavos);
    expect([...valores].sort((a, b) => a - b)).toEqual(valores);
    expect(Object.keys(r.body.data[0])).not.toEqual(expect.arrayContaining(['clienteId']));
    expect(JSON.stringify(r.body)).not.toMatch(/cliente|cpf|telefone|endereco|payload|assinatura/i);
    expect((await get(`/vendas?${Q}&sortBy=senhaHash`)).status).toBe(200); // coluna fora da whitelist é ignorada, não executada
    expect((await get(`/vendas?${Q}&limit=1000`)).status).toBe(422);
    expect((await get('/vendas?de=2020-01-01&ate=2026-10-31')).status).toBe(422);
    expect((await get(`/vendas?${Q}&grupo=CALL_CENTER`)).body.meta.total).toBe(1);
    expect((await get(`/vendas?${Q}&loja=Loja%20B&metodo=CARTAO`)).body.meta.total).toBe(3);
    expect((await get("/vendas?de=2026-10-01&ate=2026-10-31&loja=x'%20OR%201=1--")).body.meta.total).toBe(0); // parametrizado
  });

  it('detalhe de pedido inexistente => 404; rotas estáticas não colidem com /:pedido', async () => {
    expect((await get('/vendas/NAO-EXISTE')).status).toBe(404);
    expect((await get(`/vendas/resumo?${Q}`)).status).toBe(200);
    expect((await get('/vendas/P2')).body.data).toMatchObject({ pedido: 'P2', tipoVenda: 'UPSELL', valorVendaCentavos: 9700, valorTotalCentavos: 9700 });
    expect((await get('/vendas/P1')).body.data).toMatchObject({ valorVendaCentavos: 29700, valorTotalCentavos: 31000 });
  });

  it('status da integração informa atualidade dos dados (e metadados em cada resposta)', async () => {
    const s = (await get('/integracoes/sheets/status', leitura)).body.data;
    expect(s).toMatchObject({ estado: 'ATUALIZADO', dadosDesatualizados: false });
    expect(s.ultimaSincronizacao).not.toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/ultimoErro/); // LEITURA não vê mensagens de erro
    const meta = (await get(`/dashboard/kpis?${Q}`)).body.meta;
    expect(meta.ultimaSincronizacao).not.toBeNull();
    expect(meta.dadosDesatualizados).toBe(false);
    await prisma.fonteDados.update({ where: { tipo: 'EVENTOS' }, data: { ultimoSucessoEm: new Date(Date.now() - 3_600_000) } });
    expect((await get(`/dashboard/kpis?${Q}`)).body.meta.dadosDesatualizados).toBe(true);
    expect((await get('/integracoes/sheets/status', leitura)).body.data.dadosDesatualizados).toBe(true);
  });

  it('simulação de regra não altera o banco e reporta o impacto', async () => {
    const antes = await prisma.venda.findMany({ select: { pedido: true, grupo: true }, orderBy: { pedido: 'asc' } });
    const r = await request(app).post('/api/v1/classificacoes/simular').set('Authorization', financeiro).send({
      regra: { campo: 'LOJA', operador: 'IGUAL', valor: 'Loja B', grupo: 'BACKEND_OUTROS', prioridade: 50 },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.vendasQueCasam).toBeGreaterThan(0);
    expect(r.body.data.observacao).toMatch(/somente leitura/);
    expect(await prisma.venda.findMany({ select: { pedido: true, grupo: true }, orderBy: { pedido: 'asc' } })).toEqual(antes);
  });
});

describe('datas próximas à meia-noite (America/Sao_Paulo)', () => {
  beforeAll(async () => {
    await resetDb();
    admin = await tokenDe('ADMIN');
    const sheets = new FakeSheets();
    for (const [p, quando] of [['N1', '31/10/2026 23:59:30'], ['N2', '01/11/2026 00:00:30'], ['N3', '01/11/2026 00:00:00']] as const) {
      sheets.addEvento(pagamento(p, { pago_em: quando, recebido_em: quando, valor_sem_juros: '10,00' }));
    }
    await new SyncService(new GoogleSheetsService(sheets), { batchSize: 10 }).executar(['EVENTOS'], 'INICIAL');
  });

  it('23:59:30 de 31/10 é outubro; 00:00:00 de 01/11 já é novembro (fronteira em SP, não em UTC)', async () => {
    const out = (await get('/vendas?de=2026-10-01&ate=2026-10-31')).body.data.map((v: { pedido: string }) => v.pedido);
    const nov = (await get('/vendas?de=2026-11-01&ate=2026-11-30')).body.data.map((v: { pedido: string }) => v.pedido).sort();
    expect(out).toEqual(['N1']);
    expect(nov).toEqual(['N2', 'N3']);
  });
});
