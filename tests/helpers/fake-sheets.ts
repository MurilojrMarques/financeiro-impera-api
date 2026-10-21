import type { SheetsReader, TabInfo } from '../../src/integrations/google-sheets/google-sheets.client';

export const H_EVENTOS = [
  'recebido_em', 'pago_em', 'evento', 'pedido', 'tipo', 'cliente_id', 'afiliado', 'loja', 'checkout', 'produto',
  'valor_total', 'valor_sem_juros', 'valor_liquido', 'comissao', 'comissao_fonte', 'metodo', 'parcelas',
  'utm_source', 'utm_campaign', 'utm_content', 'src', 'teste', 'assinatura', 'payload_sem_dados_pessoais', 'canal', 'subcanal', 'origem_lead',
];
export const H_HISTORICO = [
  'Número do Pedido', 'Status', 'Data de Criação', 'Data de Pagamento', 'Data de Estorno', 'Tipo de Venda', 'Origem',
  'Tipo de Atendimento', 'Atendente', 'Loja', 'Produto', 'Método de Pagamento', 'Valor Total', 'Valor sem Juros', 'Juros',
  'Comissão', 'Taxa do Call Center', 'Comissão Afiliado', 'Campanha', 'Click ID', 'Nome do Afiliado',
];
export const H_REDTRACK = ['Pedido', 'Conversão', 'Payout', 'Situação da Conciliação', 'Campanha', 'Anúncio'];

/** Planilha em memória. Cada aba = cabeçalho + linhas. Permite injetar falhas e latência. */
export class FakeSheets implements SheetsReader {
  tabs: Record<string, { header: string[]; rows: string[][] }> = {
    EVENTOS: { header: [...H_EVENTOS], rows: [] },
    HISTORICO: { header: [...H_HISTORICO], rows: [] },
    REDTRACK: { header: [...H_REDTRACK], rows: [] },
  };
  /** lança este erro em readRows quando a função retornar true (chamada nº, aba) */
  failWhen: ((call: number, tab: string) => unknown | null) | null = null;
  listError: unknown = null;
  delayMs = 0;
  calls = 0;
  readRowsCalls: { tab: string; start: number }[] = [];

  async listTabs(): Promise<TabInfo[]> {
    if (this.listError) throw this.listError;
    return Object.entries(this.tabs).map(([title, t]) => ({ title, rowCount: t.rows.length + 1 }));
  }
  async readHeader(tab: string): Promise<string[]> {
    return this.tabs[tab].header;
  }
  async readRows(tab: string, startDataRow: number, count: number): Promise<string[][]> {
    this.calls++;
    this.readRowsCalls.push({ tab, start: startDataRow });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const err = this.failWhen?.(this.calls, tab);
    if (err) throw err;
    return this.tabs[tab].rows.slice(startDataRow - 1, startDataRow - 1 + count);
  }

  /** Acrescenta linha em EVENTOS a partir de campos nomeados. */
  addEvento(f: Partial<Record<(typeof H_EVENTOS)[number], string>>): void {
    this.tabs.EVENTOS.rows.push(this.tabs.EVENTOS.header.map((h) => f[h] ?? ''));
  }
  addHistorico(f: Partial<Record<string, string>>): void {
    this.tabs.HISTORICO.rows.push(this.tabs.HISTORICO.header.map((h) => f[h] ?? ''));
  }
  addRedtrack(f: Partial<Record<string, string>>): void {
    this.tabs.REDTRACK.rows.push(this.tabs.REDTRACK.header.map((h) => f[h] ?? ''));
  }
  /** Altera um campo de uma linha de EVENTOS existente (simula correção na planilha). */
  setEvento(rowIndex: number, campo: string, valor: string): void {
    this.tabs.EVENTOS.rows[rowIndex][this.tabs.EVENTOS.header.indexOf(campo)] = valor;
  }
}
