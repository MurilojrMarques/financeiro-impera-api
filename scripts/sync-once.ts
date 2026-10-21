/**
 * Executa UMA sincronização completa (HISTORICO → EVENTOS → REDTRACK) e imprime somente contagens.
 * Uso: `npm run sync:once`. Respeita o lock do PostgreSQL (não roda junto com o worker).
 */
import { closeDatabase, prisma } from '../src/config/database';
import { GoogleSheetsClient } from '../src/integrations/google-sheets/google-sheets.client';
import { GoogleSheetsService } from '../src/integrations/google-sheets/google-sheets.service';
import { SyncService } from '../src/modules/sincronizacao/sync.service';

async function main(): Promise<void> {
  const sync = new SyncService(new GoogleSheetsService(new GoogleSheetsClient()));
  const resultados = await sync.executar(['HISTORICO', 'EVENTOS', 'REDTRACK'], 'COMPLETA', 'cli:sync-once');
  for (const r of resultados) {
    console.log(`${r.fonte}: ${r.status} | lidos ${r.lidos} inseridos ${r.inseridos} atualizados ${r.atualizados} ignorados ${r.ignorados} erros ${r.comErro} | ${Math.round(r.duracaoMs / 1000)}s${r.erro ? ` | ${r.erro}` : ''}`);
  }
  const erros = await prisma.erroImportacao.groupBy({ by: ['fonte', 'codigo', 'campo'], _count: { _all: true }, orderBy: { _count: { codigo: 'desc' } }, take: 15 });
  if (erros.length) console.log('Erros por tipo:', erros.map((e) => `${e.fonte}/${e.codigo}/${e.campo ?? '-'}=${e._count._all}`).join(', '));
  const [vendas, eventos, grupos] = await Promise.all([
    prisma.venda.count(),
    prisma.vendaEvento.count(),
    prisma.venda.groupBy({ by: ['grupo'], _count: { _all: true } }),
  ]);
  console.log(`Banco: ${vendas} vendas, ${eventos} eventos. Grupos: ${grupos.map((g) => `${g.grupo}=${g._count._all}`).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
