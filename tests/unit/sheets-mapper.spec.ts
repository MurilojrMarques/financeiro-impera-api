import { describe, expect, it } from 'vitest';
import { GoogleSheetsService, SheetsIntegrationError } from '../../src/integrations/google-sheets/google-sheets.service';
import { buildColumnMap } from '../../src/integrations/google-sheets/google-sheets.mapper';
import type { SheetsReader } from '../../src/integrations/google-sheets/google-sheets.client';
import { isTransientGoogleError, withRetry } from '../../src/shared/utils/retry';
import { sanitizeError } from '../../src/shared/utils/text';

const HEADER_EVENTOS = ['recebido_em', 'pago_em', 'evento', 'pedido', 'tipo', 'afiliado', 'loja', 'valor_total', 'valor_sem_juros', 'comissao', 'teste', 'coluna_nova'];

function fakeReader(over: Partial<SheetsReader> = {}): SheetsReader {
  return {
    listTabs: async () => [{ title: 'EVENTOS', rowCount: 10 }, { title: 'HISTORICO', rowCount: 10 }, { title: 'REDTRACK', rowCount: 10 }],
    readHeader: async () => HEADER_EVENTOS,
    readRows: async () => [],
    ...over,
  };
}

describe('mapeamento de cabeçalhos', () => {
  it('lê pelos cabeçalhos reais, não pela posição (colunas embaralhadas)', () => {
    const map = buildColumnMap('EVENTOS', ['valor_sem_juros', 'pedido', 'evento']);
    expect(map.indices).toMatchObject({ valor_sem_juros: 0, pedido: 1, evento: 2 });
  });

  it('normaliza acento, caixa e espaços do cabeçalho', () => {
    const map = buildColumnMap('HISTORICO', ['Número do Pedido', 'Status', 'Valor sem Juros', 'Nome do Afiliado']);
    expect(map.ausentesObrigatorios).toEqual([]);
    expect(map.indices.afiliado).toBe(3);
  });

  it('detecta colunas obrigatórias ausentes/alteradas e colunas desconhecidas', () => {
    const map = buildColumnMap('EVENTOS', ['pedido', 'evt', 'coluna_nova']);
    expect(map.ausentesObrigatorios.sort()).toEqual(['evento', 'valor_sem_juros']);
    expect(map.desconhecidos).toEqual(expect.arrayContaining(['evt', 'coluna_nova']));
  });

  it('mapeamento é extensível por aliases configuráveis', () => {
    const map = buildColumnMap('HISTORICO', ['pedido', 'status', 'valor_sem_juros', 'operador_cc'], { HISTORICO: { atendente: ['operador_cc'] } });
    expect(map.indices.atendente).toBe(3);
  });

  it('assinatura muda quando o cabeçalho muda (dispara releitura completa)', () => {
    expect(buildColumnMap('EVENTOS', ['a', 'pedido']).assinatura).not.toBe(buildColumnMap('EVENTOS', ['pedido', 'a']).assinatura);
  });
});

describe('GoogleSheetsService', () => {
  it('aba inexistente', async () => {
    const svc = new GoogleSheetsService(fakeReader({ listTabs: async () => [{ title: 'OUTRA', rowCount: 1 }] }));
    await expect(svc.validateTab('EVENTOS')).rejects.toMatchObject({ codigo: 'ABA_INEXISTENTE' });
  });

  it('cabeçalho obrigatório ausente', async () => {
    const svc = new GoogleSheetsService(fakeReader({ readHeader: async () => ['pedido'] }));
    await expect(svc.validateTab('EVENTOS')).rejects.toMatchObject({ codigo: 'CABECALHO_OBRIGATORIO_AUSENTE' });
  });

  it.each([
    [{ response: { status: 401 } }, 'CREDENCIAIS_INVALIDAS'],
    [{ message: 'invalid_grant: Invalid JWT Signature' }, 'CREDENCIAIS_INVALIDAS'],
    [{ response: { status: 403 } }, 'PLANILHA_INACESSIVEL'],
    [{ response: { status: 404 } }, 'PLANILHA_INACESSIVEL'],
    [{ response: { status: 503 } }, 'INDISPONIVEL'],
  ])('traduz erro do Google %j em %s sem vazar detalhes', async (err, codigo) => {
    const svc = new GoogleSheetsService(fakeReader({ listTabs: async () => { throw err; } }));
    const e = await svc.validateTab('EVENTOS').catch((x) => x);
    expect(e).toBeInstanceOf(SheetsIntegrationError);
    expect(e.codigo).toBe(codigo);
  });

  it('linhas incompletas/inválidas: válidas passam, inválidas viram erro sem expor o valor da célula', async () => {
    const svc = new GoogleSheetsService(fakeReader());
    const map = await svc.validateTab('EVENTOS');
    const row = (pedido: string, evento: string, valor: string, data = '05/10/2026 10:00:00') =>
      HEADER_EVENTOS.map((h) => ({ recebido_em: data, pago_em: data, evento, pedido, valor_sem_juros: valor, valor_total: valor, comissao: '', teste: '' }[h] ?? ''));
    const lote = svc.parseRows('EVENTOS', map, [row('1', 'pagamento', '297,00'), row('2', 'pagamento', 'SEGREDO-123'), [], row('', 'pagamento', '1'), row('4', 'pagamento', '10', '99/99/2026')], 1);
    expect(lote.valid.map((v) => v.data.pedido)).toEqual(['1']);
    expect(lote.vazias).toBe(1);
    // uma linha pode ter vários campos inválidos (um erro por campo); o conjunto de linhas é o que importa
    expect([...new Set(lote.invalid.map((i) => i.linha))].sort()).toEqual([2, 4, 5]);
    expect(JSON.stringify(lote.invalid)).not.toContain('SEGREDO-123');
    expect(lote.valid[0].data.comissao).toBeNull(); // vazio ≠ zero
    expect(lote.lidas).toBe(5);
  });
});

describe('retry com backoff exponencial e jitter', () => {
  it('tenta de novo em erro transitório com delays dentro do teto exponencial', async () => {
    const delays: number[] = [];
    let n = 0;
    const r = await withRetry(async () => { if (++n < 4) throw { response: { status: 429 } }; return 'ok'; }, {
      retries: 5, baseMs: 100, isRetryable: isTransientGoogleError, sleep: async (ms) => void delays.push(ms), random: () => 0.999,
    });
    expect(r).toBe('ok');
    expect(delays).toEqual([99, 199, 399]); // < 100*2^n (jitter cheio)
  });

  it('não repete erro permanente (403) e respeita o limite de tentativas', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw { response: { status: 403 } }; }, { retries: 5, isRetryable: isTransientGoogleError, sleep: async () => {} })).rejects.toBeTruthy();
    expect(n).toBe(1);
    let m = 0;
    await expect(withRetry(async () => { m++; throw { response: { status: 500 } }; }, { retries: 2, isRetryable: isTransientGoogleError, sleep: async () => {} })).rejects.toBeTruthy();
    expect(m).toBe(3);
  });
});

describe('sanitização de erros', () => {
  it('remove chave privada, e-mail e CPF', () => {
    const msg = sanitizeError(new Error('falha -----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY----- user@x.com 123.456.789-09 token=abc123'));
    expect(msg).not.toMatch(/ABC|user@x\.com|123\.456\.789-09|abc123/);
  });
});
