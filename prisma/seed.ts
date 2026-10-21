/**
 * Seed mínimo e seguro: apenas registra as fontes de dados (abas). Nenhum dado financeiro fictício,
 * nenhum usuário e nenhuma senha são criados aqui (use `npm run bootstrap:admin`).
 */
import { prisma, closeDatabase } from '../src/config/database';
import { env } from '../src/config/env';

async function main(): Promise<void> {
  const fontes = [
    { tipo: 'HISTORICO' as const, nomeAba: env.SHEET_TAB_HISTORICO, intervaloSegundos: 86_400 },
    { tipo: 'EVENTOS' as const, nomeAba: env.SHEET_TAB_EVENTOS, intervaloSegundos: env.SYNC_EVENTOS_INTERVAL_SECONDS },
    { tipo: 'REDTRACK' as const, nomeAba: env.SHEET_TAB_REDTRACK, intervaloSegundos: env.SYNC_REDTRACK_INTERVAL_SECONDS },
  ];
  for (const f of fontes) {
    await prisma.fonteDados.upsert({ where: { tipo: f.tipo }, create: f, update: { nomeAba: f.nomeAba, intervaloSegundos: f.intervaloSegundos } });
  }
  console.log('Fontes de dados registradas.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
