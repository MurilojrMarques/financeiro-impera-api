/**
 * Espelha o sistema de RH de origem (MySQL impera_rh · app_state, do Alexandre) nas tabelas relacionais desta API e mostra o que mudou.
 * SOMENTE LEITURA na origem. Repetível: usa o id da origem como chave (`legadoId`); rodar de novo atualiza, não duplica.
 * A API também faz isso sozinha, de tempos em tempos (monitoramento contínuo); este comando serve para rodar na hora, ou em simulação.
 *
 *   npm run rh:importar              → simulação (não grava; mostra o que mudaria)
 *   npm run rh:importar -- --aplicar → grava e registra a sincronização
 *
 * Nunca imprime dados pessoais nem salários: só contagens por tipo de mudança.
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database';
import { lerOrigem } from '../src/integrations/rh-mysql/rh-mysql';
import { registrarSincronizacao, sincronizarRh } from '../src/modules/rh/rh.sync';

const aplicar = process.argv.includes('--aplicar');

async function main(): Promise<void> {
  const origem = await lerOrigem();
  const r = await sincronizarRh(origem, { aplicar });
  console.log(`${aplicar ? 'APLICADO' : 'SIMULAÇÃO'} — origem salva em ${origem.atualizadoEm?.toISOString() ?? '?'}: ${r.lidos} colaboradores lidos, ${r.novos} novos, ${r.atualizados} com alteração`);
  const porTipo = new Map<string, number>();
  for (const a of r.alteracoes) porTipo.set(a.tipo, (porTipo.get(a.tipo) ?? 0) + 1);
  console.log(`alterações detectadas: ${r.alteracoes.length}${r.alteracoes.length ? ` (${[...porTipo].map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`);
  console.log(`inconsistências na origem (salário atual ≠ último reajuste): ${r.inconsistencias.length}`);
  if (r.avisos.length) {
    const resumo = new Map<string, number>();
    for (const a of r.avisos) resumo.set(a, (resumo.get(a) ?? 0) + 1);
    console.log(`avisos (${r.avisos.length}):`);
    for (const [a, n] of resumo) console.log(`  - ${a}${n > 1 ? ` (x${n})` : ''}`);
  }
  if (aplicar) await registrarSincronizacao('script', origem, r, null);
  else console.log('\nNada foi gravado. Rode com --aplicar para gravar.');
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
