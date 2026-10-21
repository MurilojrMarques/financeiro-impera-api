import type { sheets_v4 } from 'googleapis';
import { createSheetsApi, requireSheetId } from '../../config/google';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { isTransientGoogleError, withRetry } from '../../shared/utils/retry';

export interface TabInfo {
  title: string;
  rowCount: number;
}

/** Contrato mínimo usado pelo serviço de sincronização (permite fake nos testes). */
export interface SheetsReader {
  listTabs(): Promise<TabInfo[]>;
  /** Cabeçalho = linha 1 da aba. */
  readHeader(tab: string): Promise<string[]>;
  /** Lê `count` linhas de DADOS a partir da linha de dados `startDataRow` (1 = primeira linha abaixo do cabeçalho). */
  readRows(tab: string, startDataRow: number, count: number): Promise<string[][]>;
}

const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export class GoogleSheetsClient implements SheetsReader {
  private api: sheets_v4.Sheets | null = null;
  private readonly spreadsheetId: string;

  constructor(api?: sheets_v4.Sheets, spreadsheetId?: string) {
    this.api = api ?? null;
    this.spreadsheetId = spreadsheetId ?? requireSheetId();
  }

  private sheets(): sheets_v4.Sheets {
    this.api ??= createSheetsApi();
    return this.api;
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      retries: env.SHEETS_MAX_RETRIES,
      isRetryable: isTransientGoogleError,
      onRetry: (attempt, delayMs) => logger.warn({ attempt, delayMs }, 'Google Sheets: erro transitório, nova tentativa'),
    });
  }

  async listTabs(): Promise<TabInfo[]> {
    const res = await this.call(() =>
      this.sheets().spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets.properties(title,gridProperties.rowCount)',
      }),
    );
    return (res.data.sheets ?? []).map((s) => ({
      title: s.properties?.title ?? '',
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    }));
  }

  async readHeader(tab: string): Promise<string[]> {
    const res = await this.call(() =>
      this.sheets().spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteTab(tab)}!1:1`,
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    );
    return (res.data.values?.[0] ?? []).map((v) => String(v));
  }

  async readRows(tab: string, startDataRow: number, count: number): Promise<string[][]> {
    const first = startDataRow + 1; // +1 pula o cabeçalho
    const last = first + count - 1;
    const res = await this.call(() =>
      this.sheets().spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteTab(tab)}!${first}:${last}`,
        valueRenderOption: 'FORMATTED_VALUE',
        majorDimension: 'ROWS',
      }),
    );
    return (res.data.values ?? []).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
  }
}
