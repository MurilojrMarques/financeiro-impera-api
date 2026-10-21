/**
 * Diagnóstico de conexão com o Google Sheets (somente leitura). Uso: `npm run check:sheets`
 * Mostra: abas encontradas, nº de linhas de dados, cabeçalhos reconhecidos/ausentes/desconhecidos.
 * NÃO imprime valores de células, credenciais nem o ID da planilha.
 */
import { GoogleSheetsClient } from '../src/integrations/google-sheets/google-sheets.client';
import { GoogleSheetsService, SheetsIntegrationError } from '../src/integrations/google-sheets/google-sheets.service';
import { buildColumnMap, parseAliasOverrides, type TabKey } from '../src/integrations/google-sheets/google-sheets.mapper';
import { env } from '../src/config/env';

async function main(): Promise<void> {
  const client = new GoogleSheetsClient();
  const service = new GoogleSheetsService(client);
  const tabs = await client.listTabs().catch((e) => {
    throw new SheetsIntegrationError('INDISPONIVEL', `Falha ao listar abas: ${(e as { response?: { status?: number } }).response?.status ?? (e as Error).message}`);
  });
  console.log('Conexão OK. Abas na planilha:', tabs.map((t) => `${t.title} (${t.rowCount} linhas na grade)`).join(', '));

  const overrides = parseAliasOverrides(env.SHEET_HEADER_ALIASES_JSON);
  for (const tab of ['HISTORICO', 'EVENTOS', 'REDTRACK'] as TabKey[]) {
    const nome = service.tabName(tab);
    if (!tabs.some((t) => t.title === nome)) {
      console.log(`\n[${tab}] ABA "${nome}" NÃO ENCONTRADA`);
      continue;
    }
    const header = await client.readHeader(nome);
    const map = buildColumnMap(tab, header, overrides);
    const primeira = await client.readRows(nome, 1, 1);
    console.log(`\n[${tab}] aba "${nome}" — ${header.length} colunas; primeira linha de dados ${primeira.length ? 'existe' : 'AUSENTE'}`);
    console.log('  reconhecidos     :', Object.keys(map.indices).join(', ') || '-');
    console.log('  obrigatórios falt.:', map.ausentesObrigatorios.join(', ') || 'nenhum');
    console.log('  opcionais ausentes:', map.ausentesOpcionais.join(', ') || 'nenhum');
    console.log('  não mapeados     :', map.desconhecidos.join(', ') || 'nenhum');
  }
}

main().catch((e) => {
  console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
