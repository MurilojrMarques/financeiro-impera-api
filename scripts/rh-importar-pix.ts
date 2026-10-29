/**
 * Importa a chave PIX dos colaboradores a partir de um JSON `[{ "nome": "...", "pix": "...", "colaboradorId"?: "uuid" }]`.
 * Casa pelo nome (sem acento e sem maiúsculas: todas as palavras do nome da lista precisam estar no nome do colaborador do RH). Nome que casa com
 * mais de um colaborador, ou com nenhum, NÃO é gravado: o relatório lista e a linha ganha o `colaboradorId` na mão. Sem `--aplicar` só mostra o relatório.
 * As chaves PIX são dado pessoal: o arquivo fica fora do repositório e este script nunca imprime a chave.
 *
 *   npx tsx scripts/rh-importar-pix.ts caminho/pix.json            (relatório)
 *   npx tsx scripts/rh-importar-pix.ts caminho/pix.json --aplicar  (grava; recusa se sobrar nome ambíguo ou sem par)
 *   npx tsx scripts/rh-importar-pix.ts caminho/pix.json --aplicar --parcial  (grava só os que casaram e lista o resto)
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { closeDatabase, prisma } from '../src/config/database';

interface Entrada {
  nome: string;
  pix: string;
  colaboradorId?: string;
}

const STOP = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
const tokens = (s: string): string[] => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));

async function main() {
  const [arquivo, ...flags] = process.argv.slice(2);
  if (!arquivo) throw new Error('Uso: tsx scripts/rh-importar-pix.ts <arquivo.json> [--aplicar]');
  const aplicar = flags.includes('--aplicar');
  const parcial = flags.includes('--parcial');
  const entradas = JSON.parse(readFileSync(arquivo, 'utf8')) as Entrada[];
  const colabs = await prisma.rhColaborador.findMany({ select: { id: true, nome: true, demissao: true, pix: true } });
  const porId = new Map(colabs.map((c) => [c.id, c]));
  const tk = new Map(colabs.map((c) => [c.id, new Set(tokens(c.nome))]));

  const casados: { id: string; nome: string; pix: string; colab: string }[] = [];
  const ambiguos: string[] = [];
  const semPar: string[] = [];
  for (const e of entradas) {
    const pix = e.pix.trim();
    if (!/^\S{3,120}$/.test(pix)) {
      semPar.push(`${e.nome} (chave inválida)`);
      continue;
    }
    if (e.colaboradorId) {
      const c = porId.get(e.colaboradorId);
      if (c) casados.push({ id: c.id, nome: e.nome, pix, colab: c.nome });
      else semPar.push(`${e.nome} (colaboradorId não existe)`);
      continue;
    }
    const buscados = tokens(e.nome);
    const candidatos = colabs.filter((c) => buscados.every((t) => tk.get(c.id)!.has(t)));
    if (candidatos.length === 1) casados.push({ id: candidatos[0]!.id, nome: e.nome, pix, colab: candidatos[0]!.nome });
    else if (candidatos.length === 0) semPar.push(e.nome);
    else ambiguos.push(`${e.nome} → ${candidatos.map((c) => `${c.nome}${c.demissao ? ' (desligado)' : ''} [${c.id}]`).join(' | ')}`);
  }

  const repetidos = casados.filter((c, i) => casados.findIndex((x) => x.id === c.id) !== i);
  console.log(`Entradas: ${entradas.length} | casadas: ${casados.length} | ambíguas: ${ambiguos.length} | sem par: ${semPar.length}`);
  for (const c of casados) console.log(`  ok   ${c.nome.padEnd(42)} → ${c.colab}`);
  for (const a of ambiguos) console.log(`  ???  ${a}`);
  for (const s of semPar) console.log(`  NÃO  ${s}`);
  if (repetidos.length > 0) throw new Error(`Dois nomes caíram no mesmo colaborador: ${repetidos.map((r) => r.colab).join(', ')}. Corrija com colaboradorId.`);

  const semPix = colabs.filter((c) => c.demissao === null && !c.pix && !casados.some((x) => x.id === c.id)).map((c) => c.nome);
  console.log(`Ativos que continuam sem PIX: ${semPix.length}${semPix.length ? ` (${semPix.join(', ')})` : ''}`);
  if (!aplicar) return console.log('\nRelatório apenas. Rode com --aplicar para gravar.');
  if (!parcial && (ambiguos.length > 0 || semPar.length > 0)) throw new Error('Há nomes ambíguos ou sem par: resolva (colaboradorId) ou use --parcial para gravar só os que casaram.');

  let alterados = 0;
  await prisma.$transaction(
    casados.map((c) => {
      if (porId.get(c.id)!.pix !== c.pix) alterados++;
      return prisma.rhColaborador.update({ where: { id: c.id }, data: { pix: c.pix } });
    }),
  );
  console.log(`\nGravado: ${casados.length} colaboradores (${alterados} alterados).`);
}

main().catch((e) => { console.error('ERRO', e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(closeDatabase);
