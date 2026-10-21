import { readFileSync } from 'node:fs';
import { google, type sheets_v4 } from 'googleapis';
import { env } from './env';

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/** Credenciais vêm de variável de ambiente (arquivo fora do Git OU JSON em base64). Nunca hardcoded. */
export function loadCredentials(): ServiceAccountCredentials {
  let raw: string | undefined;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    raw = Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8');
  } else if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      raw = readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    } catch {
      throw new Error('Arquivo de credenciais do Google não pôde ser lido (verifique GOOGLE_APPLICATION_CREDENTIALS)');
    }
  }
  if (!raw) throw new Error('Credenciais do Google não configuradas');
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
    if (!parsed.client_email || !parsed.private_key) throw new Error('campos ausentes');
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch {
    throw new Error('Credenciais do Google inválidas (JSON malformado ou incompleto)');
  }
}

export function createSheetsApi(): sheets_v4.Sheets {
  const creds = loadCredentials();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'], // somente leitura
  });
  return google.sheets({ version: 'v4', auth, timeout: env.GOOGLE_TIMEOUT_MS } as never);
}

export function requireSheetId(): string {
  if (!env.GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID não configurado');
  return env.GOOGLE_SHEET_ID;
}
