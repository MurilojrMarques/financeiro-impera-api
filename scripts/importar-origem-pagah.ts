/**
 * Importa a `origem` do Pagah (Site, Call, Whats, nome do vendedor…) para as vendas que ainda não a têm.
 *
 * POR QUÊ: a planilha de histórico trouxe a origem de todo o mês de setembro e parou em outubro, e o fechamento do dono
 * decide Call Center por ela (origem que contém "Call" ou "Whats"). Sem origem a venda cai no canal da planilha, que
 * chama de Call Center vendedores que o dono não conta. Este script é a ponte até a origem chegar sozinha do Pagah.
 *
 * ENTRADA: um CSV exportado do Pagah (ou da aba "Pedidos" do fechamento do dono) com as colunas `id_pedido` e `origem`.
 * Qualquer outra coluna é ignorada. Nada de dado pessoal é lido nem gravado: só o número do pedido e a origem.
 *
 * Uso:
 *   npx tsx scripts/importar-origem-pagah.ts caminho/pedidos.csv              # simulação: só conta, não grava
 *   npx tsx scripts/importar-origem-pagah.ts caminho/pedidos.csv --aplicar    # grava e reclassifica
 *   ... --sobrescrever                                                        # troca também a origem que já existe e difere
 *
 * Só preenche venda SEM origem, a menos que --sobrescrever. Quem difere é listado (contagem), nunca trocado em silêncio.
 * Reclassifica depois de gravar (a origem do Pagah decide o Call Center das vendas pagas a partir de 01/10/2026).
 */
import { readFileSync } from 'node:fs';
import { closeDatabase, prisma } from '../src/config/database';
import { reclassificarTodas } from '../src/modules/classificacoes/classificacoes.service';

/** CSV mínimo (RFC 4180): campos entre aspas, vírgula ou ponto e vírgula, quebras de linha dentro de aspas. */
export function lerCsv(texto: string): string[][] {
  const t = texto.replace(/^﻿/, '');
  const sep = (t.split('\n', 1)[0] ?? '').split(';').length > (t.split('\n', 1)[0] ?? '').split(',').length ? ';' : ',';
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.some((x) => x !== '')) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x !== '')) linhas.push(linha);
  return linhas;
}

/** O id do pedido como o sistema o guarda: dígitos, sem ".0" de planilha. */
export function pedidoDe(bruto: string): string | null {
  const m = /^(\d+)(?:\.0+)?$/.exec(bruto.trim());
  return m ? m[1]! : null;
}

async function main(): Promise<void> {
  const [arquivo, ...flags] = process.argv.slice(2);
  if (!arquivo) throw new Error('uso: importar-origem-pagah.ts <arquivo.csv> [--aplicar] [--sobrescrever]');
  const aplicar = flags.includes('--aplicar');
  const sobrescrever = flags.includes('--sobrescrever');

  const linhas = lerCsv(readFileSync(arquivo, 'utf8'));
  const cab = (linhas[0] ?? []).map((c) => c.trim().toLowerCase());
  const iPed = cab.indexOf('id_pedido');
  const iOri = cab.indexOf('origem');
  if (iPed < 0 || iOri < 0) throw new Error(`o CSV precisa das colunas id_pedido e origem (achei: ${cab.join(', ')})`);

  const doArquivo = new Map<string, string>();
  let invalidas = 0;
  for (const l of linhas.slice(1)) {
    const ped = pedidoDe(l[iPed] ?? '');
    const ori = (l[iOri] ?? '').trim();
    if (!ped || !ori) { invalidas++; continue; }
    doArquivo.set(ped, ori);
  }

  const existentes = new Map<string, string | null>();
  const ids = [...doArquivo.keys()];
  for (let i = 0; i < ids.length; i += 5000) {
    const lote = await prisma.venda.findMany({ where: { pedido: { in: ids.slice(i, i + 5000) } }, select: { pedido: true, origem: true } });
    for (const v of lote) existentes.set(v.pedido, v.origem);
  }

  const preencher: [string, string][] = [];
  let iguais = 0, difere = 0, ausentes = 0;
  const difs = new Map<string, number>();
  for (const [ped, ori] of doArquivo) {
    if (!existentes.has(ped)) { ausentes++; continue; }
    const atual = existentes.get(ped) ?? null;
    if (atual === null) preencher.push([ped, ori]);
    else if (atual === ori) iguais++;
    else {
      difere++;
      difs.set(`${atual} → ${ori}`, (difs.get(`${atual} → ${ori}`) ?? 0) + 1);
      if (sobrescrever) preencher.push([ped, ori]);
    }
  }

  console.log(`arquivo: ${doArquivo.size} pedidos com origem (${invalidas} linhas sem id ou sem origem)`);
  console.log(`no banco: ${doArquivo.size - ausentes} | fora do banco (ainda não sincronizados): ${ausentes}`);
  console.log(`a preencher: ${preencher.length} | já iguais: ${iguais} | com origem diferente: ${difere}${sobrescrever ? ' (serão trocadas)' : ' (ficam como estão; use --sobrescrever)'}`);
  if (difs.size) console.log('  diferenças mais comuns:', [...difs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} (${n})`).join(' | '));

  if (!aplicar) {
    console.log('\nsimulação: nada foi gravado. Rode com --aplicar para gravar e reclassificar.');
    return;
  }
  let gravadas = 0;
  for (let i = 0; i < preencher.length; i += 500) {
    await prisma.$transaction(
      preencher.slice(i, i + 500).map(([pedido, origem]) => prisma.venda.update({ where: { pedido }, data: { origem } })),
    );
    gravadas += Math.min(500, preencher.length - i);
  }
  // A origem é do VENDEDOR (96 vendedores, uma origem cada, em 100% dos pedidos de outubro): guarda a ponte vendedor → origem
  // para que o pedido novo que chega só com o `vendedorId` do Pagah ganhe a origem sozinho. Vendedor com mais de uma origem
  // nos pedidos do arquivo não entra (é listado), e um vendedor que já está na tabela só é trocado com --sobrescrever.
  const pedidosDoArquivo = [...doArquivo.keys()];
  const conflitos = await prisma.$queryRaw<{ vendedorId: string; origens: string }[]>`
    SELECT v."vendedorId", string_agg(DISTINCT v.origem, ' | ') AS origens
      FROM vendas v WHERE v.pedido = ANY(${pedidosDoArquivo}::text[]) AND v."vendedorId" IS NOT NULL AND v.origem IS NOT NULL
     GROUP BY v."vendedorId" HAVING count(DISTINCT v.origem) > 1`;
  const mapeados = sobrescrever
    ? await prisma.$executeRaw`
        INSERT INTO vendedores_pagah ("vendedorId", "origem", "fonte", "atualizadoEm")
        SELECT v."vendedorId", min(v.origem), 'importado do Pagah (CSV)', now()
          FROM vendas v WHERE v.pedido = ANY(${pedidosDoArquivo}::text[]) AND v."vendedorId" IS NOT NULL AND v.origem IS NOT NULL
         GROUP BY v."vendedorId" HAVING count(DISTINCT v.origem) = 1
        ON CONFLICT ("vendedorId") DO UPDATE SET origem = EXCLUDED.origem, fonte = EXCLUDED.fonte, "atualizadoEm" = now()`
    : await prisma.$executeRaw`
        INSERT INTO vendedores_pagah ("vendedorId", "origem", "fonte", "atualizadoEm")
        SELECT v."vendedorId", min(v.origem), 'importado do Pagah (CSV)', now()
          FROM vendas v WHERE v.pedido = ANY(${pedidosDoArquivo}::text[]) AND v."vendedorId" IS NOT NULL AND v.origem IS NOT NULL
         GROUP BY v."vendedorId" HAVING count(DISTINCT v.origem) = 1
        ON CONFLICT ("vendedorId") DO NOTHING`;
  const alteradas = await reclassificarTodas();
  console.log(`\ngravadas ${gravadas} origens | vendedores na tabela: +${mapeados} | reclassificadas ${alteradas} vendas`);
  if (conflitos.length) console.log(`vendedores com mais de uma origem no arquivo (ficaram de fora): ${conflitos.map((c) => `${c.vendedorId} [${c.origens}]`).join(' ; ')}`);
}

if (process.argv[1]?.endsWith('importar-origem-pagah.ts')) {
  main()
    .catch((e) => {
      console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
