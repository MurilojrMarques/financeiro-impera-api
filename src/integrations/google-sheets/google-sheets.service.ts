import type { ZodType } from 'zod';
import { env } from '../../config/env';
import type { SheetsReader } from './google-sheets.client';
import {
  buildColumnMap,
  isBlankRow,
  parseAliasOverrides,
  rowToRecord,
  type AliasOverrides,
  type ColumnMap,
  type TabKey,
} from './google-sheets.mapper';
import { eventoRowSchema, historicoRowSchema, redtrackRowSchema } from './google-sheets.schemas';
import type { EventoRow, HistoricoRow, RedtrackRow } from './google-sheets.schemas';

export type IntegrationErrorCode =
  | 'CREDENCIAIS_INVALIDAS'
  | 'PLANILHA_INACESSIVEL'
  | 'ABA_INEXISTENTE'
  | 'CABECALHO_OBRIGATORIO_AUSENTE'
  | 'INDISPONIVEL';

export class SheetsIntegrationError extends Error {
  constructor(
    public readonly codigo: IntegrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SheetsIntegrationError';
  }
}

export interface ParsedRow<T> {
  /** Linha de DADOS (1 = primeira abaixo do cabeçalho). Usada só para rastreio/cursor — não é identidade. */
  linha: number;
  data: T;
}

export interface ParseIssue {
  linha: number;
  codigo: string;
  campo: string | null;
  mensagem: string;
}

export interface ParsedBatch<T> {
  valid: ParsedRow<T>[];
  invalid: ParseIssue[];
  /** linhas totalmente em branco (ignoradas) */
  vazias: number;
  /** total de linhas retornadas pela API neste lote */
  lidas: number;
  /** última linha de dados lida (para avanço de cursor) */
  ultimaLinha: number;
}

type RowTypes = { EVENTOS: EventoRow; HISTORICO: HistoricoRow; REDTRACK: RedtrackRow };

const SCHEMAS: { [K in TabKey]: ZodType<RowTypes[K]> } = {
  EVENTOS: eventoRowSchema as unknown as ZodType<EventoRow>,
  HISTORICO: historicoRowSchema as unknown as ZodType<HistoricoRow>,
  REDTRACK: redtrackRowSchema as unknown as ZodType<RedtrackRow>,
};

export class GoogleSheetsService {
  private readonly overrides: AliasOverrides;
  private readonly tabNames: Record<TabKey, string>;

  constructor(
    private readonly reader: SheetsReader,
    tabNames?: Partial<Record<TabKey, string>>,
    overrides?: AliasOverrides,
  ) {
    this.overrides = overrides ?? parseAliasOverrides(env.SHEET_HEADER_ALIASES_JSON);
    this.tabNames = {
      HISTORICO: tabNames?.HISTORICO ?? env.SHEET_TAB_HISTORICO,
      EVENTOS: tabNames?.EVENTOS ?? env.SHEET_TAB_EVENTOS,
      REDTRACK: tabNames?.REDTRACK ?? env.SHEET_TAB_REDTRACK,
    };
  }

  tabName(tab: TabKey): string {
    return this.tabNames[tab];
  }

  /** Verifica planilha, existência das abas e cabeçalhos obrigatórios. Não loga nem devolve dados de linhas. */
  async validateTab(tab: TabKey): Promise<ColumnMap> {
    const nome = this.tabNames[tab];
    let tabs;
    try {
      tabs = await this.reader.listTabs();
    } catch (err) {
      throw this.translate(err);
    }
    if (!tabs.some((t) => t.title === nome)) {
      throw new SheetsIntegrationError('ABA_INEXISTENTE', `Aba "${nome}" não encontrada na planilha`);
    }
    let header: string[];
    try {
      header = await this.reader.readHeader(nome);
    } catch (err) {
      throw this.translate(err);
    }
    const map = buildColumnMap(tab, header, this.overrides);
    if (map.ausentesObrigatorios.length > 0) {
      throw new SheetsIntegrationError(
        'CABECALHO_OBRIGATORIO_AUSENTE',
        `Aba "${nome}": colunas obrigatórias ausentes ou renomeadas: ${map.ausentesObrigatorios.join(', ')}`,
      );
    }
    return map;
  }

  async validateAll(): Promise<Record<TabKey, ColumnMap>> {
    const [EVENTOS, HISTORICO, REDTRACK] = await Promise.all([
      this.validateTab('EVENTOS'),
      this.validateTab('HISTORICO'),
      this.validateTab('REDTRACK'),
    ]);
    return { EVENTOS, HISTORICO, REDTRACK };
  }

  /** Lê um lote e transforma em objetos tipados, separando linhas válidas de inválidas. */
  async readBatch<K extends TabKey>(tab: K, map: ColumnMap, startDataRow: number, size: number): Promise<ParsedBatch<RowTypes[K]>> {
    let rows: string[][];
    try {
      rows = await this.reader.readRows(this.tabNames[tab], startDataRow, size);
    } catch (err) {
      throw this.translate(err);
    }
    return this.parseRows(tab, map, rows, startDataRow);
  }

  parseRows<K extends TabKey>(tab: K, map: ColumnMap, rows: string[][], startDataRow: number): ParsedBatch<RowTypes[K]> {
    const valid: ParsedRow<RowTypes[K]>[] = [];
    const invalid: ParseIssue[] = [];
    let vazias = 0;
    rows.forEach((row, i) => {
      const linha = startDataRow + i;
      if (isBlankRow(row)) {
        vazias++;
        return;
      }
      const parsed = SCHEMAS[tab].safeParse(rowToRecord(row, map));
      if (parsed.success) {
        valid.push({ linha, data: parsed.data });
      } else {
        for (const issue of parsed.error.issues) {
          invalid.push({
            linha,
            codigo: 'LINHA_INVALIDA',
            campo: issue.path.join('.') || null,
            // mensagem de validação não contém o valor da célula (sem dados sensíveis)
            mensagem: issue.message,
          });
        }
      }
    });
    return { valid, invalid, vazias, lidas: rows.length, ultimaLinha: startDataRow + rows.length - 1 };
  }

  private translate(err: unknown): SheetsIntegrationError {
    if (err instanceof SheetsIntegrationError) return err;
    const e = err as { code?: number | string; status?: number; response?: { status?: number }; message?: string };
    const status = e.response?.status ?? e.status ?? (typeof e.code === 'number' ? e.code : undefined);
    if (status === 401 || /invalid_grant|invalid_client|DECODER|private key|credenciais/i.test(e.message ?? '')) {
      return new SheetsIntegrationError('CREDENCIAIS_INVALIDAS', 'Credenciais do Google inválidas ou sem acesso');
    }
    if (status === 403 || status === 404) {
      return new SheetsIntegrationError(
        'PLANILHA_INACESSIVEL',
        'Planilha inacessível: confirme o GOOGLE_SHEET_ID e o compartilhamento com a Service Account',
      );
    }
    if (/Credenciais do Google|GOOGLE_SHEET_ID|GOOGLE_APPLICATION_CREDENTIALS/.test(e.message ?? '')) {
      return new SheetsIntegrationError('CREDENCIAIS_INVALIDAS', e.message ?? 'Credenciais do Google inválidas');
    }
    return new SheetsIntegrationError('INDISPONIVEL', 'Google Sheets indisponível no momento');
  }
}
