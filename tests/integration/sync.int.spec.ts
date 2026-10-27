import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { GoogleSheetsService } from '../../src/integrations/google-sheets/google-sheets.service';
import { SyncBusyError, SyncService } from '../../src/modules/sincronizacao/sync.service';
import { FakeSheets } from '../helpers/fake-sheets';
import { resetDb } from '../helpers/db';

const pagamento = (pedido: string, extra: Record<string, string> = {}) => ({
  recebido_em: '05/10/2026 10:00:00', pago_em: '05/10/2026 10:00:00', evento: 'pagamento', pedido, tipo: 'front', loja: 'Loja A',
  produto: 'Kit 3', valor_total: '310,00', valor_sem_juros: '297,00', comissao: '100,00', comissao_fonte: 'estimada', metodo: 'cartao', parcelas: '3', ...extra,
});

function setup(batchSize = 2, lookbackRows = 2) {
  const sheets = new FakeSheets();
  const sync = new SyncService(new GoogleSheetsService(sheets), { batchSize, lookbackRows });
  return { sheets, sync };
}

describe('sincronização Google Sheets -> PostgreSQL', () => {
  beforeEach(resetDb);
  afterAll(closeDatabase);

  it('importação inicial grava vendas e eventos, registra a execução e o estado da fonte', async () => {
    const { sheets, sync } = setup();
    for (let i = 1; i <= 5; i++) sheets.addEvento(pagamento(`P${i}`));
    const [r] = await sync.executar(['EVENTOS'], 'INICIAL');
    expect(r).toMatchObject({ status: 'SUCESSO', lidos: 5, inseridos: 5, atualizados: 0, comErro: 0 });
    expect(await prisma.venda.count()).toBe(5);
    expect(await prisma.vendaEvento.count()).toBe(5);
    const fonte = await prisma.fonteDados.findUnique({ where: { tipo: 'EVENTOS' } });
    expect(fonte).toMatchObject({ estado: 'ATUALIZADA', ultimoErro: null });
    expect(fonte!.ultimoSucessoEm).not.toBeNull();
    const exec = await prisma.sincronizacao.findFirst();
    expect(exec).toMatchObject({ fonte: 'EVENTOS', modo: 'INICIAL', status: 'SUCESSO', inseridos: 5 });
    expect(exec!.duracaoMs).toBeGreaterThanOrEqual(0);
    expect((await prisma.sincronizacaoCursor.findUnique({ where: { fonte: 'EVENTOS' } }))!.ultimaLinha).toBe(5);
  });

  it('mesma sincronização duas vezes não duplica nem altera nada (idempotente)', async () => {
    const { sheets, sync } = setup();
    for (let i = 1; i <= 5; i++) sheets.addEvento(pagamento(`P${i}`));
    await sync.executar(['EVENTOS'], 'INICIAL');
    const antes = await prisma.venda.findMany({ orderBy: { pedido: 'asc' }, select: { pedido: true, hashConteudo: true, atualizadoEm: true } });
    const [r2] = await sync.executar(['EVENTOS'], 'COMPLETA');
    expect(r2).toMatchObject({ status: 'SUCESSO', inseridos: 0, atualizados: 0, ignorados: 5 });
    const [r3] = await sync.executar(['EVENTOS'], 'INCREMENTAL');
    expect(r3).toMatchObject({ inseridos: 0, atualizados: 0 });
    expect(await prisma.venda.count()).toBe(5);
    expect(await prisma.vendaEvento.count()).toBe(5);
    const depois = await prisma.venda.findMany({ orderBy: { pedido: 'asc' }, select: { pedido: true, hashConteudo: true, atualizadoEm: true } });
    expect(depois).toEqual(antes); // nem atualizadoEm mudou: nenhuma escrita
  });

  it('incremental lê só o que é novo (+ janela de releitura) e detecta registros novos', async () => {
    const { sheets, sync } = setup(100, 1);
    for (let i = 1; i <= 10; i++) sheets.addEvento(pagamento(`P${i}`));
    await sync.executar(['EVENTOS'], 'INICIAL');
    sheets.readRowsCalls.length = 0;
    sheets.addEvento(pagamento('P11'));
    const [r] = await sync.executar(['EVENTOS'], 'INCREMENTAL');
    expect(r.inseridos).toBe(1);
    expect(sheets.readRowsCalls[0]).toEqual({ tab: 'EVENTOS', start: 10 }); // cursor(10) − lookback(1) + 1
    expect(await prisma.venda.count()).toBe(11);
  });

  it('comissão corrigida na planilha atualiza a MESMA venda (estimada -> Pagah)', async () => {
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('P1'));
    await sync.executar(['EVENTOS'], 'INICIAL');
    expect(await prisma.venda.findUnique({ where: { pedido: 'P1' } })).toMatchObject({ comissaoCentavos: 10000, comissaoFonte: 'ESTIMADA' });

    sheets.setEvento(0, 'comissao', '180,00');
    sheets.setEvento(0, 'comissao_fonte', 'pagah');
    const [r] = await sync.executar(['EVENTOS'], 'INCREMENTAL');
    expect(r).toMatchObject({ inseridos: 0, atualizados: 1 });
    expect(await prisma.venda.count()).toBe(1);
    expect(await prisma.venda.findUnique({ where: { pedido: 'P1' } })).toMatchObject({ comissaoCentavos: 18000, comissaoFonte: 'PAGAH' });
  });

  it('estorno e chargeback chegam depois: mesma venda, 3 eventos, perda única, status mais recente', async () => {
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('P1'));
    await sync.executar(['EVENTOS'], 'INICIAL');
    sheets.addEvento(pagamento('P1', { evento: 'estorno', recebido_em: '10/10/2026 09:00:00' }));
    sheets.addEvento(pagamento('P1', { evento: 'chargeback', recebido_em: '25/10/2026 09:00:00' }));
    // reenvio do mesmo webhook de estorno (outro horário/linha) não pode duplicar
    sheets.addEvento(pagamento('P1', { evento: 'estorno', recebido_em: '10/10/2026 09:05:00' }));
    await sync.executar(['EVENTOS'], 'INCREMENTAL');
    const v = await prisma.venda.findUnique({ where: { pedido: 'P1' }, include: { eventos: true } });
    expect(v!.eventos.map((e) => e.tipo).sort()).toEqual(['CHARGEBACK', 'ESTORNO', 'PAGAMENTO']);
    expect(v).toMatchObject({ status: 'CHARGEBACK', perdaCentavos: 29700, perdaTipo: 'CHARGEBACK' });
    expect(v!.estornadoEm).not.toBeNull();
    expect(v!.chargebackEm).not.toBeNull();
    expect(await prisma.venda.count()).toBe(1);
  });

  it('registros de teste são ignorados; linhas inválidas viram erro sanitizado sem derrubar o lote', async () => {
    const { sheets, sync } = setup();
    sheets.addEvento(pagamento('OK1'));
    sheets.addEvento(pagamento('TESTE1', { teste: 'true' }));
    sheets.addEvento(pagamento('RUIM1', { valor_sem_juros: 'VALOR-SECRETO' }));
    sheets.addEvento(pagamento('RUIM2', { evento: 'carrinho_abandonado' }));
    sheets.addEvento(pagamento('', {})); // sem pedido
    const [r] = await sync.executar(['EVENTOS'], 'INICIAL');
    expect(r.status).toBe('PARCIAL');
    expect(r.inseridos).toBe(1);
    expect(r.comErro).toBe(3);
    expect(await prisma.venda.findMany({ select: { pedido: true } })).toEqual([{ pedido: 'OK1' }]);
    const erros = await prisma.erroImportacao.findMany();
    expect(erros.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(erros)).not.toContain('VALOR-SECRETO');
    // reprocessar a mesma planilha não multiplica os erros já registrados
    const antes = await prisma.erroImportacao.count();
    await sync.executar(['EVENTOS'], 'COMPLETA');
    expect(await prisma.erroImportacao.count()).toBe(antes);
  });

  it('Google indisponível no meio da carga: dados já gravados permanecem, cursor só avança até o lote persistido, retentativa conclui sem duplicar', async () => {
    const { sheets, sync } = setup(2, 0);
    for (let i = 1; i <= 6; i++) sheets.addEvento(pagamento(`P${i}`));
    sheets.failWhen = (call) => (call === 2 ? { response: { status: 503 } } : null); // 2º lote falha
    const [falha] = await sync.executar(['EVENTOS'], 'INICIAL');
    expect(falha.status).toBe('FALHA');
    expect(await prisma.venda.count()).toBe(2); // só o 1º lote foi gravado
    expect((await prisma.sincronizacaoCursor.findUnique({ where: { fonte: 'EVENTOS' } }))!.ultimaLinha).toBe(2);
    const fonte = await prisma.fonteDados.findUnique({ where: { tipo: 'EVENTOS' } });
    expect(fonte).toMatchObject({ estado: 'INDISPONIVEL' });
    expect(fonte!.ultimoSucessoEm).toBeNull();

    sheets.failWhen = null;
    const [ok] = await sync.executar(['EVENTOS'], 'INCREMENTAL');
    expect(ok.status).toBe('SUCESSO');
    expect(await prisma.venda.count()).toBe(6);
    expect(await prisma.vendaEvento.count()).toBe(6);
  });

  it('Google fora do ar não apaga dados já sincronizados; estado e mensagem sanitizada ficam registrados', async () => {
    const { sheets, sync } = setup();
    sheets.addEvento(pagamento('P1'));
    await sync.executar(['EVENTOS'], 'INICIAL');
    sheets.listError = { response: { status: 503 }, message: 'falha com token=abc123 e user@x.com' };
    const [r] = await sync.executar(['EVENTOS'], 'INCREMENTAL');
    expect(r.status).toBe('FALHA');
    expect(await prisma.venda.count()).toBe(1);
    const fonte = await prisma.fonteDados.findUnique({ where: { tipo: 'EVENTOS' } });
    expect(fonte!.estado).toBe('INDISPONIVEL');
    expect(fonte!.ultimoSucessoEm).not.toBeNull(); // último sucesso anterior preservado
    expect(JSON.stringify(await prisma.sincronizacao.findMany())).not.toMatch(/abc123|user@x\.com/);
  });

  it.each([
    [{ response: { status: 401 } }, 'CREDENCIAIS_INVALIDAS'],
    [{ response: { status: 403 } }, 'PLANILHA_INACESSIVEL'],
  ])('credenciais/acesso inválidos (%j) => estado %s', async (err, estado) => {
    const { sheets, sync } = setup();
    sheets.listError = err;
    const [r] = await sync.executar(['EVENTOS'], 'INICIAL');
    expect(r.status).toBe('FALHA');
    expect((await prisma.fonteDados.findUnique({ where: { tipo: 'EVENTOS' } }))!.estado).toBe(estado);
  });

  it('aba inexistente e cabeçalho obrigatório alterado são detectados e nada é importado', async () => {
    const { sheets, sync } = setup();
    delete sheets.tabs.REDTRACK;
    const [r1] = await sync.executar(['REDTRACK'], 'INICIAL');
    expect(r1.status).toBe('FALHA');
    expect((await prisma.fonteDados.findUnique({ where: { tipo: 'REDTRACK' } }))!.estado).toBe('ABA_INEXISTENTE');

    sheets.tabs.EVENTOS.header[sheets.tabs.EVENTOS.header.indexOf('valor_sem_juros')] = 'valor_liquido_final';
    sheets.addEvento(pagamento('P1'));
    const [r2] = await sync.executar(['EVENTOS'], 'INICIAL');
    expect(r2.status).toBe('FALHA');
    expect((await prisma.fonteDados.findUnique({ where: { tipo: 'EVENTOS' } }))!.estado).toBe('CABECALHO_OBRIGATORIO_AUSENTE');
    expect(await prisma.venda.count()).toBe(0);
  });

  it('mudança de cabeçalho (colunas reordenadas) força releitura completa e lê pelos nomes', async () => {
    const { sheets, sync } = setup(100, 0);
    sheets.addEvento(pagamento('P1'));
    sheets.addEvento(pagamento('P2'));
    await sync.executar(['EVENTOS'], 'INICIAL');
    // inverte as duas primeiras colunas na planilha inteira
    const t = sheets.tabs.EVENTOS;
    [t.header[0], t.header[1]] = [t.header[1], t.header[0]];
    t.rows.forEach((r) => ([r[0], r[1]] = [r[1], r[0]]));
    sheets.readRowsCalls.length = 0;
    const [r] = await sync.executar(['EVENTOS'], 'INCREMENTAL');
    expect(sheets.readRowsCalls[0].start).toBe(1);
    expect(r.status).toBe('SUCESSO');
    expect(await prisma.venda.count()).toBe(2);
  });

  it('duas sincronizações simultâneas: lock no PostgreSQL deixa só uma executar (a outra recebe SyncBusyError)', async () => {
    const a = setup(1, 0);
    for (let i = 1; i <= 4; i++) a.sheets.addEvento(pagamento(`P${i}`));
    a.sheets.delayMs = 150;
    const b = new SyncService(new GoogleSheetsService(a.sheets), { batchSize: 1, lookbackRows: 0 }); // "outra instância"
    const [x, y] = await Promise.allSettled([a.sync.executar(['EVENTOS'], 'INICIAL'), (async () => { await new Promise((r) => setTimeout(r, 200)); return b.executar(['EVENTOS'], 'INICIAL'); })()]);
    expect(x.status).toBe('fulfilled');
    expect(y.status).toBe('rejected');
    expect((y as PromiseRejectedResult).reason).toBeInstanceOf(SyncBusyError);
    expect(await prisma.venda.count()).toBe(4);
    // depois que a primeira termina, o lock foi liberado
    a.sheets.delayMs = 0;
    await expect(b.executar(['EVENTOS'], 'INCREMENTAL')).resolves.toBeTruthy();
  });

  it('HISTORICO + EVENTOS do mesmo pedido: uma venda; histórico manda em comissão/atributos; evento posterior é preservado', async () => {
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('P1', { comissao: '100,00', comissao_fonte: 'estimada' }));
    sheets.addHistorico({
      'Número do Pedido': 'P1', Status: 'Pago', 'Data de Criação': '05/10/2026 09:50:00', 'Data de Pagamento': '05/10/2026 10:00:00',
      'Tipo de Venda': 'front', Origem: 'Site', Loja: 'Loja A', Produto: 'Kit 3', 'Valor Total': '310,00', 'Valor sem Juros': '297,00',
      Comissão: '175,50', Campanha: 'camp-x',
    });
    await sync.executar(['EVENTOS', 'HISTORICO'], 'INICIAL');
    let v = await prisma.venda.findUnique({ where: { pedido: 'P1' }, include: { eventos: true } });
    expect(await prisma.venda.count()).toBe(1);
    expect(v!.eventos.filter((e) => e.tipo === 'PAGAMENTO')).toHaveLength(1);
    expect(v).toMatchObject({ comissaoCentavos: 17550, comissaoFonte: 'HISTORICO_EXATA', fonteVerdade: 'HISTORICO', campanha: 'camp-x' });

    sheets.addEvento(pagamento('P1', { evento: 'estorno', recebido_em: '12/10/2026 08:00:00', comissao: '999,00', comissao_fonte: 'estimada' }));
    await sync.executar(['EVENTOS'], 'INCREMENTAL');
    v = await prisma.venda.findUnique({ where: { pedido: 'P1' }, include: { eventos: true } });
    expect(v).toMatchObject({ status: 'ESTORNADO', perdaCentavos: 29700, comissaoCentavos: 17550 });
    expect(v!.eventos).toHaveLength(2);
  });

  it('histórico estornado sem pagamento anterior: não fabrica pagamento nem desconta em dobro', async () => {
    const { sheets, sync } = setup();
    sheets.addHistorico({
      'Número do Pedido': 'H1', Status: 'Estornado', 'Data de Criação': '01/09/2026 10:00:00', 'Data de Pagamento': '',
      'Data de Estorno': '10/10/2026 10:00:00', 'Tipo de Venda': 'front', Loja: 'Loja A', 'Valor sem Juros': '100,00', Comissão: '',
    });
    await sync.executar(['HISTORICO'], 'INICIAL');
    const v = await prisma.venda.findUnique({ where: { pedido: 'H1' }, include: { eventos: true } });
    expect(v!.eventos.map((e) => e.tipo)).toEqual(['ESTORNO']);
    expect(v).toMatchObject({ status: 'PENDENTE_CONCILIACAO', perdaCentavos: 10000, comissaoCentavos: null, comissaoFonte: 'AUSENTE' });
  });

  it('RedTrack: payout substitui a comissão ESTIMADA (mesma venda), mesmo chegando antes da venda; não sobrescreve comissão do histórico; desligável por configuração', async () => {
    const { sheets, sync } = setup();
    sheets.addRedtrack({ Pedido: 'P1', 'Conversão': 'cv1', Payout: '55,00', 'Situação da Conciliação': 'conciliado', Campanha: 'camp-rt', 'Anúncio': 'ad-1' });
    await sync.executar(['REDTRACK'], 'INICIAL');
    expect(await prisma.redtrackConversao.findUnique({ where: { pedido: 'P1' } })).toMatchObject({ vendaId: null, payoutCentavos: 5500 });
    sheets.addEvento(pagamento('P1'));
    await sync.executar(['EVENTOS'], 'INICIAL');
    const v = await prisma.venda.findUnique({ where: { pedido: 'P1' } });
    // comissão estimada (100,00) foi trocada pelo payout exato do RedTrack (55,00), na MESMA venda
    expect(v).toMatchObject({ redtrackConciliado: true, campanha: 'camp-rt', anuncio: 'ad-1', comissaoCentavos: 5500, comissaoFonte: 'REDTRACK' });
    expect(await prisma.venda.count()).toBe(1);
    expect((await prisma.redtrackConversao.findUnique({ where: { pedido: 'P1' } }))!.vendaId).toBe(v!.id);
    const [again] = await sync.executar(['REDTRACK'], 'INCREMENTAL');
    expect(again).toMatchObject({ inseridos: 0, atualizados: 0 });

    // comissão confirmada pelo histórico NÃO é sobrescrita pelo payout
    sheets.addHistorico({
      'Número do Pedido': 'P2', Status: 'Pago', 'Data de Pagamento': '05/10/2026 10:00:00', 'Tipo de Venda': 'front', Loja: 'Loja A',
      'Valor sem Juros': '100,00', 'Valor Total': '100,00', Comissão: '70,00',
    });
    sheets.addRedtrack({ Pedido: 'P2', Payout: '30,00', 'Situação da Conciliação': 'diferente' });
    await sync.executar(['HISTORICO', 'REDTRACK'], 'COMPLETA');
    expect(await prisma.venda.findUnique({ where: { pedido: 'P2' } })).toMatchObject({ comissaoCentavos: 7000, comissaoFonte: 'HISTORICO_EXATA' });

    // desligado por configuração: o payout volta a ser só comparativo
    await prisma.configuracaoFinanceira.create({ data: { chave: 'redtrack.payoutComoComissao', valor: false } });
    sheets.addEvento(pagamento('P3'));
    sheets.addRedtrack({ Pedido: 'P3', Payout: '10,00' });
    await sync.executar(['EVENTOS', 'REDTRACK'], 'COMPLETA');
    expect(await prisma.venda.findUnique({ where: { pedido: 'P3' } })).toMatchObject({ comissaoCentavos: 10000, comissaoFonte: 'ESTIMADA' });
  });

  it('X1 (Pix sem líquido do vendedor 889739) identificado pelo payload; dados pessoais do payload NUNCA chegam ao banco', async () => {
    await prisma.configuracaoFinanceira.create({
      data: {
        chave: 'x1.criterio',
        valor: { todas: [{ campo: 'METODO', operador: 'IGUAL', valor: 'pix' }, { campo: 'VENDEDOR_ID', operador: 'IGUAL', valor: '889739' }, { campo: 'LIQUIDO', operador: 'IGUAL', valor: 'VAZIO' }] },
      },
    });
    const payload = (vendedor: number) =>
      JSON.stringify({ id_user_venda: vendedor, cliente_cpf: 'CPF-SECRETO-123', cliente_email: 'segredo@pessoal.test', cliente_nome: 'NOME-SECRETO', url_origem: '/checkout/v2/pedido/TOKEN-SECRETO' });
    const { sheets, sync } = setup(100, 5);
    const base = { comissao: '50,00', comissao_fonte: 'pagah' };
    sheets.addEvento(pagamento('X1A', { ...base, metodo: 'pix', valor_liquido: '', payload_sem_dados_pessoais: payload(889739) })); // X1
    sheets.addEvento(pagamento('X1B', { ...base, metodo: 'pix', valor_liquido: '40,00', payload_sem_dados_pessoais: payload(889739) })); // Pix com líquido
    sheets.addEvento(pagamento('X1C', { ...base, metodo: 'cartao', valor_liquido: '', payload_sem_dados_pessoais: payload(889739) })); // cartão
    sheets.addEvento(pagamento('X1D', { ...base, metodo: 'pix', valor_liquido: '', payload_sem_dados_pessoais: payload(111) })); // outro vendedor
    sheets.addEvento(pagamento('X1E', { ...base, metodo: 'pix', valor_liquido: '', payload_sem_dados_pessoais: 'não é json' })); // payload ilegível
    await sync.executar(['EVENTOS'], 'INICIAL');
    const x1 = Object.fromEntries((await prisma.venda.findMany()).map((v) => [v.pedido, v.x1]));
    expect(x1).toEqual({ X1A: true, X1B: false, X1C: false, X1D: false, X1E: false });
    expect((await prisma.venda.findUnique({ where: { pedido: 'X1A' } }))).toMatchObject({ vendedorId: '889739', comissaoCentavos: 5000 }); // real guardado
    // nada do payload além do id do vendedor foi persistido em NENHUMA tabela
    const tudo = JSON.stringify([
      await prisma.venda.findMany(), await prisma.vendaEvento.findMany(), await prisma.registroImportado.findMany(), await prisma.erroImportacao.findMany(),
    ]);
    expect(tudo).not.toMatch(/CPF-SECRETO|segredo@pessoal|NOME-SECRETO|TOKEN-SECRETO/);
  });

  it('valor_taxa_callcenter do payload vira a taxa do pedido (só do PAGAMENTO; a reversão do estorno não a redefine; zero é dado)', async () => {
    const payload = (taxa: number | null) => JSON.stringify({ id_user_venda: 5, cliente_nome: 'NOME-SECRETO', ...(taxa === null ? {} : { valor_taxa_callcenter: taxa }) });
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('T1', { valor_sem_juros: '300,00', payload_sem_dados_pessoais: payload(6000) }));
    sheets.addEvento(pagamento('T1', { evento: 'estorno', valor_sem_juros: '300,00', recebido_em: '10/10/2026 09:00:00', payload_sem_dados_pessoais: payload(1234) }));
    sheets.addEvento(pagamento('T2', { valor_sem_juros: '300,00', payload_sem_dados_pessoais: payload(0) }));
    sheets.addEvento(pagamento('T3', { valor_sem_juros: '300,00', payload_sem_dados_pessoais: payload(null) }));
    await sync.executar(['EVENTOS'], 'INICIAL');
    const taxa = Object.fromEntries((await prisma.venda.findMany()).map((v) => [v.pedido, v.taxaCallCenterCentavos]));
    expect(taxa).toEqual({ T1: 6000, T2: 0, T3: null });
    expect(JSON.stringify([await prisma.venda.findMany(), await prisma.registroImportado.findMany()])).not.toMatch(/NOME-SECRETO/);
  });

  it('método de pagamento padronizado entre HISTORICO ("Cartão") e EVENTOS ("cartao")', async () => {
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('M1', { metodo: 'cartao' }));
    sheets.addEvento(pagamento('M2', { metodo: 'pix' }));
    sheets.addHistorico({ 'Número do Pedido': 'M3', Status: 'Pago', 'Data de Pagamento': '05/10/2026 10:00:00', 'Tipo de Venda': 'front', Loja: 'Loja A', 'Método de Pagamento': 'Cartão', 'Valor sem Juros': '10,00' });
    sheets.addHistorico({ 'Número do Pedido': 'M4', Status: 'Pago', 'Data de Pagamento': '05/10/2026 10:00:00', 'Tipo de Venda': 'front', Loja: 'Loja A', 'Método de Pagamento': 'Pix', 'Valor sem Juros': '10,00' });
    await sync.executar(['EVENTOS', 'HISTORICO'], 'INICIAL');
    const grupos = await prisma.venda.groupBy({ by: ['metodoPagamento'], _count: { _all: true } });
    expect(Object.fromEntries(grupos.map((g) => [g.metodoPagamento, g._count._all]))).toEqual({ 'Cartão': 2, Pix: 2 });
  });

  it('comissão do AFILIADO: valor exato do HISTORICO prevalece; sem ele vale a regra do afiliado; a da operação nunca é tocada', async () => {
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('F1', { afiliado: 'André Pinheiro', comissao: '90,00', comissao_fonte: 'pagah' }));
    sheets.addHistorico({
      'Número do Pedido': 'F2', Status: 'Pago', 'Data de Pagamento': '05/10/2026 10:00:00', 'Tipo de Venda': 'front', Loja: 'Loja A',
      'Valor sem Juros': '297,00', Comissão: '80,00', 'Comissão Afiliado': '150,00', 'Nome do Afiliado': 'André Pinheiro',
    });
    await sync.executar(['EVENTOS', 'HISTORICO'], 'INICIAL');
    const andre = (await prisma.afiliado.findFirst())!;
    await prisma.regraComissaoAfiliado.create({ data: { afiliadoId: andre.id, valorFixoCentavos: 24000, vigenteDe: new Date('2026-01-01T00:00:00-03:00'), fonte: 'teste' } });
    await sync.executar(['EVENTOS', 'HISTORICO'], 'COMPLETA'); // reconciliação aplica a regra
    expect(await prisma.venda.findUnique({ where: { pedido: 'F1' } })).toMatchObject({ comissaoCentavos: 9000, comissaoFonte: 'PAGAH', comissaoAfiliadoCentavos: 24000, comissaoAfiliadoFonte: 'REGRA_AFILIADO' });
    expect(await prisma.venda.findUnique({ where: { pedido: 'F2' } })).toMatchObject({ comissaoCentavos: 8000, comissaoFonte: 'HISTORICO_EXATA', comissaoAfiliadoCentavos: 15000, comissaoAfiliadoFonte: 'HISTORICO_EXATA' });
  });

  it('afiliado: nomes equivalentes (caixa/acento/espaços) = mesma pessoa; nomes parecidos = pessoas diferentes; alias une', async () => {
    const { sheets, sync } = setup(100, 5);
    sheets.addEvento(pagamento('A1', { afiliado: 'André Pinheiro' }));
    sheets.addEvento(pagamento('A2', { afiliado: '  ANDRE   pinheiro ' }));
    sheets.addEvento(pagamento('A3', { afiliado: 'Andre Pinheiro Jr' }));
    await sync.executar(['EVENTOS'], 'INICIAL');
    const afs = await prisma.afiliado.findMany({ orderBy: { nome: 'asc' } });
    expect(afs).toHaveLength(2);
    expect(afs.find((a) => a.nome === 'André Pinheiro')).toBeTruthy(); // nome original preservado
    const vendas = await prisma.venda.findMany({ orderBy: { pedido: 'asc' } });
    expect(vendas[0].afiliadoId).toBe(vendas[1].afiliadoId);
    expect(vendas[2].afiliadoId).not.toBe(vendas[0].afiliadoId);
    expect(vendas.every((v) => v.grupo === 'AFILIADO')).toBe(true);
  });
});
