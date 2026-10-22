import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from './env';

function createClient(): PrismaClient {
  // Sessão SEMPRE em UTC: o adapter grava/lê instantes como horário da sessão. Com o banco em America/Sao_Paulo (padrão de um
  // Postgres instalado no Windows/Brasil) todo timestamptz era gravado 3h deslocado e as janelas por dia ficavam erradas.
  // statement_timeout: uma consulta presa não derruba o servidor (o limite do pool é pequeno); idle_in_transaction evita travas esquecidas.
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    options: `-c TimeZone=UTC -c statement_timeout=${env.DB_STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=60000`,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = createClient();

export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}
