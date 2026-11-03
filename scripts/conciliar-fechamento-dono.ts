/**
 * Concilia, pedido a pedido, o fechamento do Call Center do sistema com o arquivo que o dono fecha na mão com o Pagah.
 * Só LÊ (do CSV e do banco): não grava nada. Diz, para cada diferença, o que o sistema sabe do pedido, para decidir se o erro
 * é de regra, de dado ou de data (e o que só o Pagah pode confirmar).
 *
 * Entrada: dois CSVs exportados das abas do arquivo dele.
 *   --pedidos      aba "Pedidos": id_pedido, origem, tipo_pagamento, total_pedido, valor_sem_juros
 *   --chargebacks  aba "Chargebacks": id_pedido, origem, status, valor_sem_juros
 * e o período: --de AAAA-MM-DD --ate AAAA-MM-DD. Opcional --posicao AAAA-MM-DD: "como estava" no começo desse dia (o arquivo
 * dele reflete o dia em que foi exportado; o padrão é o fim do período).
 *
 * Uso: npx tsx scripts/conciliar-fechamento-dono.ts --pedidos p.csv --chargebacks c.csv --de 2026-10-01 --ate 2026-10-31 --posicao 2026-11-03
 */
import { readFileSync } from 'node:fs';
import { closeDatabase } from '../src/config/database';
import { origemEhCallCenter } from '../src/modules/classificacoes/classificacao.service';
import { separarFechamento, valorDaPlanilha, type VendaDoFechamento } from '../src/modules/call-center/fechamento.domain';
import { vendasDoFechamento } from '../src/modules/call-center/fechamento.service';
import { lerCsv, pedidoDe } from './importar-origem-pagah';

const arg = (nome: string): string | undefined => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const R = (centavos: number) => (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const reais = (x: string | undefined): number => Math.round(Number((x ?? '').replace(',', '.') || 0) * 100);
const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

interface Linha { origem: string; valor: number; extra: Record<string, string> }

function ler(arquivo: string, colunas: string[]): Map<string, Linha & { raw: Record<string, string> }> {
  const linhas = lerCsv(readFileSync(arquivo, 'utf8'));
  const cab = (linhas[0] ?? []).map((c) => c.trim().toLowerCase());
  const idx = (c: string) => cab.indexOf(c);
  for (const c of colunas) if (idx(c) < 0) throw new Error(`${arquivo}: falta a coluna ${c} (achei: ${cab.join(', ')})`);
  const saida = new Map<string, Linha & { raw: Record<string, string> }>();
  for (const l of linhas.slice(1)) {
    const ped = pedidoDe(l[idx('id_pedido')] ?? '');
    if (!ped) continue;
    const raw = Object.fromEntries(cab.map((c, i) => [c, l[i] ?? '']));
    saida.set(ped, { origem: raw.origem ?? '', valor: 0, extra: {}, raw });
  }
  return saida;
}

async function main(): Promise<void> {
  const de = arg('de');
  const ate = arg('ate');
  const pedidosCsv = arg('pedidos');
  const cbCsv = arg('chargebacks');
  if (!de || !ate || !pedidosCsv || !cbCsv) throw new Error('uso: --pedidos p.csv --chargebacks c.csv --de AAAA-MM-DD --ate AAAA-MM-DD [--posicao AAAA-MM-DD]');
  const posicao = arg('posicao') ? new Date(`${arg('posicao')}T00:00:00-03:00`) : undefined;

  const pedidos = ler(pedidosCsv, ['id_pedido', 'origem', 'tipo_pagamento', 'total_pedido', 'valor_sem_juros']);
  const cbs = ler(cbCsv, ['id_pedido', 'origem', 'valor_sem_juros']);
  const donoVendas = new Map<string, number>();
  for (const [k, x] of pedidos) {
    if (!origemEhCallCenter(x.origem)) continue;
    const cartao = (x.raw.tipo_pagamento ?? '').toLowerCase().startsWith('cart');
    donoVendas.set(k, reais(cartao ? x.raw.valor_sem_juros : x.raw.total_pedido));
  }
  const donoCb = new Map<string, number>();
  for (const [k, x] of cbs) if (origemEhCallCenter(x.origem)) donoCb.set(k, reais(x.raw.valor_sem_juros));

  const { inicio, fim } = { inicio: new Date(`${de}T00:00:00-03:00`), fim: new Date(new Date(`${ate}T00:00:00-03:00`).getTime() + 24 * 3_600_000) };
  const todas = await vendasDoFechamento(inicio, fim);
  const porPedido = new Map<string, VendaDoFechamento>(todas.map((v) => [v.pedido, v]));
  const c = separarFechamento({ de, ate }, todas, posicao);
  const nossasVendas = new Map(c.vendidas.map((v) => [v.pedido, valorDaPlanilha(v)]));
  const nossosCb = new Map(c.chargebacks.map((v) => [v.pedido, v.valorVendaCentavos]));

  // fora do período que o sistema carregou, o pedido pode existir: busca individual não é feita aqui, é "ausente do recorte"
  const nosso = (k: string) => {
    const v = porPedido.get(k);
    return v ? `${v.status} origem=${v.origem ?? '∅'} pagoEm=${dia(v.pagoEm)} perdaEm=${dia(v.perdaEm)} ${v.metodoPagamento ?? ''}${v.parcelas && v.parcelas > 1 ? ` ${v.parcelas}x` : ''}` : 'AUSENTE do banco (ou fora do recorte)';
  };
  const soma = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);

  console.log(`\n=== CONCILIAÇÃO ${de} a ${ate}${posicao ? ` | posição em ${dia(posicao)}` : ' | posição no fim do período'} ===`);
  console.log(`VENDAS Call/Whats   dono ${donoVendas.size} pedidos R$ ${R(soma(donoVendas))} | sistema ${nossasVendas.size} R$ ${R(soma(nossasVendas))} | dif R$ ${R(soma(nossasVendas) - soma(donoVendas))}`);
  console.log(`CHARGEBACKS         dono ${donoCb.size} pedidos R$ ${R(soma(donoCb))} | sistema ${nossosCb.size} R$ ${R(soma(nossosCb))} | dif R$ ${R(soma(nossosCb) - soma(donoCb))}`);

  const secao = (titulo: string, itens: string[]) => {
    console.log(`\n-- ${titulo}: ${itens.length}`);
    for (const i of itens) console.log(`   ${i}`);
  };
  secao('VENDAS só no arquivo do dono', [...donoVendas].filter(([k]) => !nossasVendas.has(k)).map(([k, v]) => `${k} R$ ${R(v)} | dono pago_em=${pedidos.get(k)?.raw.pago_em?.slice(0, 10)} | sistema: ${nosso(k)}`));
  secao('VENDAS só no sistema', [...nossasVendas].filter(([k]) => !donoVendas.has(k)).map(([k, v]) => `${k} R$ ${R(v)} | dono: ${pedidos.has(k) ? `origem=${pedidos.get(k)!.origem}` : 'NÃO está no arquivo'} | sistema: ${nosso(k)}`));
  secao('CHARGEBACKS só no arquivo do dono', [...donoCb].filter(([k]) => !nossosCb.has(k)).map(([k, v]) => `${k} R$ ${R(v)} | dono status=${cbs.get(k)?.raw.status} origem=${cbs.get(k)?.origem} | sistema: ${nosso(k)}`));
  secao('CHARGEBACKS só no sistema', [...nossosCb].filter(([k]) => !donoCb.has(k)).map(([k, v]) => `${k} R$ ${R(v)} | dono: ${cbs.has(k) ? `origem=${cbs.get(k)!.origem} status=${cbs.get(k)!.raw.status}` : 'NÃO está no arquivo'} | sistema: ${nosso(k)}`));
  const dif = [...donoCb].filter(([k, v]) => nossosCb.has(k) && nossosCb.get(k) !== v);
  secao('CHARGEBACKS nos dois com valor diferente', dif.map(([k, v]) => `${k} dono R$ ${R(v)} | sistema R$ ${R(nossosCb.get(k)!)} (${v === 0 ? 'dono em branco' : `diferença R$ ${R(nossosCb.get(k)! - v)}: possível juros embutido`}) | ${nosso(k)}`));
  const em = dif.filter(([, v]) => v !== 0);
  console.log(`\nresumo dos valores diferentes: ${dif.length - em.length} em branco no arquivo dele (R$ ${R(dif.filter(([, v]) => v === 0).reduce((s, [k]) => s + nossosCb.get(k)!, 0))}) | ${em.length} com possível juros (R$ ${R(em.reduce((s, [k, v]) => s + nossosCb.get(k)! - v, 0))})`);
}

if (process.argv[1]?.endsWith('conciliar-fechamento-dono.ts')) {
  main()
    .catch((e) => {
      console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
