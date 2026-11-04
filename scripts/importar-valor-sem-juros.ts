/**
 * Corrige o `valor_sem_juros` dos pedidos pagos ANTES de setembro que só chegaram pelo estorno/chargeback, e inclui como
 * ajuste de chargeback os pedidos que o Pagah mostra e a base ainda não tem.
 *
 * POR QUÊ: o EVENTOS só traz o evento "pago" a partir de 01/09/2026. O pedido pago em junho, julho ou agosto e revertido depois
 * só tem a linha de estorno/chargeback, e o valor dela é o TOTAL com juros (R$ 359,88 onde o Pagah diz `valor_sem_juros` R$ 298,70).
 * O fechamento manual desconta o `valor_sem_juros`. O Pagah arredonda a parcela, então não há fator que recupere o valor: a
 * única fonte é a exportação do Pagah (a aba Chargebacks do fechamento manual é uma).
 *
 * ENTRADA: CSV do Pagah com `id_pedido`, `status`, `origem`, `tipo_pagamento`, `total_pedido`, `valor_sem_juros`, `criado_em`,
 * `data_estorno`, `data_chargeback`. Nada de dado pessoal é lido nem gravado.
 *
 * O QUE FAZ (nunca em silêncio; a simulação é o padrão):
 *   1. Pedido de CARTÃO que a base tem com o valor MAIOR que o do arquivo e igual ao total do arquivo (juros dentro): grava o
 *      `valor_sem_juros` do arquivo, o juros, e a perda integral acompanha o novo valor. Divergência de outro tipo é só listada.
 *      A sincronização não desfaz isso: estorno/chargeback não redefine o valor já conhecido, e o HISTORICO, quando vier, vale.
 *   2. Com `--competencia AAAA-MM`: pedido de cartão de origem Call/Whats que o arquivo mostra revertido nessa competência e a
 *      base NÃO tem vira ajuste INCLUIR_CHARGEBACK (valor, motivo e data à vista na tela). O ajuste se desfaz sozinho quando a base
 *      passar a trazer o pedido (o fechamento não conta em dobro).
 *
 * Uso:
 *   npx tsx scripts/importar-valor-sem-juros.ts pagah.csv --competencia 2026-10            # simulação
 *   npx tsx scripts/importar-valor-sem-juros.ts pagah.csv --competencia 2026-10 --aplicar  # grava
 */
import { readFileSync } from 'node:fs';
import { closeDatabase, prisma } from '../src/config/database';
import { origemEhCallCenter } from '../src/modules/classificacoes/classificacao.service';
import { lerCsv, pedidoDe } from './importar-origem-pagah';

/** "298.7" ou "298,70" → 29870; vazio → null. */
export function centavosDe(bruto: string | undefined): number | null {
  const t = (bruto ?? '').trim().replace(',', '.');
  if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arquivo = args.find((a) => !a.startsWith('--'));
  if (!arquivo) throw new Error('uso: importar-valor-sem-juros.ts <pagah.csv> [--competencia AAAA-MM] [--aplicar]');
  const aplicar = args.includes('--aplicar');
  const iComp = args.indexOf('--competencia');
  const competencia = iComp >= 0 ? args[iComp + 1] : undefined;
  if (competencia !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) throw new Error('--competencia no formato AAAA-MM');

  const linhas = lerCsv(readFileSync(arquivo, 'utf8'));
  const cab = (linhas[0] ?? []).map((c) => c.trim().toLowerCase());
  const col = (nome: string) => cab.indexOf(nome);
  const obrigatorias = ['id_pedido', 'tipo_pagamento', 'total_pedido', 'valor_sem_juros'];
  const faltam = obrigatorias.filter((n) => col(n) < 0);
  if (faltam.length) throw new Error(`faltam colunas no CSV: ${faltam.join(', ')} (achei: ${cab.join(', ')})`);
  const ler = (l: string[], nome: string) => (col(nome) >= 0 ? (l[col(nome)] ?? '').trim() : '');

  type Linha = { pedido: string; semJuros: number; total: number | null; origem: string; status: string; operadora: string; criado: string; estorno: string; chargeback: string };
  const doArquivo = new Map<string, Linha>();
  for (const l of linhas.slice(1)) {
    const pedido = pedidoDe(ler(l, 'id_pedido'));
    const semJuros = centavosDe(ler(l, 'valor_sem_juros'));
    if (!pedido || semJuros === null || ler(l, 'tipo_pagamento').toLowerCase().replace('ã', 'a') !== 'cartao') continue; // só cartão traz valor_sem_juros
    doArquivo.set(pedido, {
      pedido, semJuros, total: centavosDe(ler(l, 'total_pedido')), origem: ler(l, 'origem'), status: ler(l, 'status'),
      operadora: ler(l, 'operadora'), criado: ler(l, 'criado_em'), estorno: ler(l, 'data_estorno'), chargeback: ler(l, 'data_chargeback'),
    });
  }

  const noBanco = new Map<string, { id: string; valorVendaCentavos: number; valorTotalCentavos: number | null; jurosCentavos: number | null; perdaCentavos: number; status: string }>();
  const ids = [...doArquivo.keys()];
  for (let i = 0; i < ids.length; i += 5000) {
    const lote = await prisma.venda.findMany({
      where: { pedido: { in: ids.slice(i, i + 5000) } },
      select: { id: true, pedido: true, valorVendaCentavos: true, valorTotalCentavos: true, jurosCentavos: true, perdaCentavos: true, status: true },
    });
    for (const v of lote) noBanco.set(v.pedido, v);
  }

  // 1) valor_sem_juros
  const corrigir: { id: string; pedido: string; de: number; para: number; total: number; perdaIntegral: boolean }[] = [];
  const divergentes: string[] = [];
  let iguais = 0;
  for (const [pedido, f] of doArquivo) {
    const v = noBanco.get(pedido);
    if (!v) continue;
    if (v.valorVendaCentavos === f.semJuros) { iguais++; continue; }
    const comJurosDentro = f.semJuros < v.valorVendaCentavos && (v.valorVendaCentavos === f.total || v.valorTotalCentavos === f.total);
    if (!comJurosDentro) { divergentes.push(`${pedido} (base ${brl(v.valorVendaCentavos)} × arquivo ${brl(f.semJuros)})`); continue; }
    corrigir.push({
      id: v.id, pedido, de: v.valorVendaCentavos, para: f.semJuros, total: v.valorTotalCentavos ?? f.total ?? v.valorVendaCentavos,
      perdaIntegral: (v.status === 'ESTORNADO' || v.status === 'CHARGEBACK') && v.perdaCentavos === v.valorVendaCentavos,
    });
  }

  // 2) pedidos do arquivo que a base não tem, de Call/Whats, revertidos na competência
  const ausentes = [...doArquivo.values()].filter(
    (f) => !noBanco.has(f.pedido) && origemEhCallCenter(f.origem) && competencia !== undefined && [f.estorno, f.chargeback].some((d) => d.slice(0, 7) === competencia),
  );
  const jaAjustados = competencia
    ? new Set((await prisma.fechamentoAjuste.findMany({ where: { competencia, pedido: { in: ausentes.map((a) => a.pedido) } }, select: { pedido: true } })).map((a) => a.pedido))
    : new Set<string>();
  const incluir = ausentes.filter((a) => !jaAjustados.has(a.pedido));

  console.log(`arquivo: ${doArquivo.size} pedidos de cartão com valor_sem_juros | na base: ${noBanco.size} | fora da base: ${doArquivo.size - noBanco.size}`);
  console.log(`valor igual: ${iguais} | a corrigir (juros dentro do valor): ${corrigir.length} (${brl(corrigir.reduce((s, c) => s + c.de - c.para, 0))} de juros) | divergentes, não tocados: ${divergentes.length}`);
  if (divergentes.length) console.log(`  divergentes: ${divergentes.slice(0, 15).join(' ; ')}${divergentes.length > 15 ? ' ; ...' : ''}`);
  if (competencia) {
    console.log(`ajustes de chargeback em ${competencia}: ${incluir.length} a criar (${brl(incluir.reduce((s, a) => s + a.semJuros, 0))}) | já existentes: ${jaAjustados.size}`);
    for (const a of incluir) console.log(`  ${a.pedido}  ${brl(a.semJuros)}  ${a.status} (${a.operadora})`);
  } else {
    console.log('sem --competencia: pedidos fora da base não viram ajuste.');
  }

  if (!aplicar) {
    console.log('\nsimulação: nada foi gravado. Rode com --aplicar para gravar.');
    return;
  }

  for (let i = 0; i < corrigir.length; i += 200) {
    await prisma.$transaction(
      corrigir.slice(i, i + 200).map((c) =>
        prisma.venda.update({
          where: { id: c.id },
          data: { valorVendaCentavos: c.para, valorTotalCentavos: c.total, jurosCentavos: c.total - c.para, ...(c.perdaIntegral ? { perdaCentavos: c.para } : {}) },
        }),
      ),
    );
  }
  for (const a of incluir) {
    const quando = [a.estorno && `estorno ${a.estorno.slice(0, 10)}`, a.chargeback && `chargeback ${a.chargeback.slice(0, 10)}`].filter(Boolean).join(', ');
    await prisma.fechamentoAjuste.create({
      data: {
        competencia: competencia!, pedido: a.pedido, acao: 'INCLUIR_CHARGEBACK', valorCentavos: a.semJuros,
        motivo: `Pagah mostra "${a.status}" (${a.operadora}, ${quando}) e a base não tem o pedido: o webhook não mandou o evento. Valor sem juros conforme a exportação do Pagah.`,
      },
    });
  }
  console.log(`\ngravado: ${corrigir.length} valores corrigidos | ${incluir.length} ajustes de chargeback criados`);
}

if (process.argv[1]?.endsWith('importar-valor-sem-juros.ts')) {
  main()
    .catch((e) => {
      console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
