import dotenv from 'dotenv';
import { z } from 'zod';

// Testes nunca leem o .env real (isolamento e nenhum risco de usar credenciais de verdade).
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default(''),
  // nº de proxies confiáveis à frente da API (ex.: 1 com Nginx). 0 = nenhum.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  SWAGGER_ENABLED: bool.default(true),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET precisa ter ao menos 32 caracteres'),
  JWT_ISSUER: z.string().default('financeiro-impera-api'),
  JWT_AUDIENCE: z.string().default('financeiro-impera-dashboard'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  COOKIE_SECURE: bool.default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),

  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
  GOOGLE_SHEET_ID: z.string().optional(),
  SHEET_TAB_HISTORICO: z.string().default('HISTORICO'),
  SHEET_TAB_EVENTOS: z.string().default('EVENTOS'),
  SHEET_TAB_REDTRACK: z.string().default('REDTRACK'),
  GOOGLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SHEETS_BATCH_SIZE: z.coerce.number().int().min(50).max(5000).default(1000),
  SHEETS_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  SHEET_HEADER_ALIASES_JSON: z.string().optional(),
  // Quantas linhas anteriores ao cursor são relidas a cada sync incremental (detecta correções recentes)
  SYNC_LOOKBACK_ROWS: z.coerce.number().int().min(0).default(500),

  // RedTrack (investimento em anúncios). A chave só existe no servidor; sem ela o investimento fica "indisponível".
  REDTRACK_API_KEY: z.string().optional(),
  REDTRACK_BASE_URL: z.string().url().default('https://api.redtrack.io'),
  REDTRACK_OFFER_FILTER: z.string().default('pagah'),
  REDTRACK_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  SYNC_ENABLED: bool.default(true),
  SYNC_EVENTOS_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  SYNC_REDTRACK_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(1800),
  SYNC_RECONCILE_TIME: z.string().regex(/^\d{2}:\d{2}$/).default('03:30'),
  STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(300),

  UPLOAD_DIR: z.string().default('./storage/anexos'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // string vazia no .env = ausente
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problemas = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração de ambiente inválida: ${problemas}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const origens = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    if (origens.length === 0 || origens.includes('*')) {
      throw new Error('Configuração de ambiente inválida: CORS_ORIGINS deve listar origens explícitas em produção');
    }
    if (!env.COOKIE_SECURE) {
      throw new Error('Configuração de ambiente inválida: COOKIE_SECURE deve ser true em produção');
    }
  }
  return env;
}

export const env: Env = parseEnv(process.env);
