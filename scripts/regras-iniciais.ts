/**
 * Aplica as regras de negócio já DECIDIDAS pelo Elias (doc "Webhook da Pagah · como funciona", 16/10/2026).
 * Idempotente: pode rodar várias vezes. Uso: `npm run regras:iniciais`.
 *
 * 1. Payout do RedTrack = comissão exata (liga `redtrack.payoutComoComissao`).
 * 2. X1 = Pix sem valor líquido do vendedor 889739 (comissão 0 nos relatórios padrão).
 * 3. André Pinheiro: comissão DO AFILIADO fixa de R$ 240,00 por venda (o `afiliado_comissao` da Pagah vem 0).
 *    SOMENTE para ele: o valor não é universal para os demais afiliados.
 * 4. Leonardo: 30% do valor da venda. Os códigos da Pagah 544 e 219 são ALIAS de André e Leonardo (juntados em 23/10/2026).
 *    Deduzido pela loja/período das vendas (544 segue o André na Erevita; 219 segue o Leonardo na Gelatina Fit): se a Pagah disser o contrário,
 *    troque as regras (DELETE/POST /afiliados/:id/regras-comissao).
 */
import { closeDatabase, prisma } from '../src/config/database';
import { recalcularComissoesPorRegra } from '../src/modules/afiliados/afiliados.service';
import { searchKey } from '../src/shared/utils/text';

const FONTE_ANDRE = 'Doc Pagah 16/10/2026 §5: afiliado_comissao vem 0; R$ 240 fixos = valor do André Pinheiro (289 de 294 vendas em set/2026)';

const FONTE_CODIGO = (txt: string): string => `Decisão do negócio 23/10/2026 (códigos da Pagah deduzidos pela loja/período das vendas): ${txt}`;

async function main(): Promise<void> {
  await prisma.configuracaoFinanceira.upsert({
    where: { chave: 'redtrack.payoutComoComissao' },
    create: { chave: 'redtrack.payoutComoComissao', valor: true },
    update: { valor: true },
  });
  console.log('redtrack.payoutComoComissao = true');

  const x1 = { todas: [{ campo: 'METODO', operador: 'IGUAL', valor: 'pix' }, { campo: 'VENDEDOR_ID', operador: 'IGUAL', valor: '889739' }, { campo: 'LIQUIDO', operador: 'IGUAL', valor: 'VAZIO' }] };
  await prisma.configuracaoFinanceira.upsert({ where: { chave: 'x1.criterio' }, create: { chave: 'x1.criterio', valor: x1 }, update: { valor: x1 } });
  console.log('x1.criterio = Pix + vendedor 889739 + sem valor líquido');

  const regras: { nome: string; fixoCentavos?: number; percentualBps?: number; fonte: string }[] = [
    { nome: 'André Pinheiro', fixoCentavos: 24000, fonte: FONTE_ANDRE },
    { nome: 'Leonardo Gomes de Oliveira Cury Moreira', percentualBps: 3000, fonte: FONTE_CODIGO('Leonardo: 30% sobre as vendas') },
  ];
  for (const r of regras) {
    const af = await prisma.afiliado.findUnique({ where: { nomeBusca: searchKey(r.nome)! } });
    if (!af) {
      console.log(`Afiliado "${r.nome}" ainda não existe no banco (rode a sincronização antes); regra não criada.`);
      continue;
    }
    const existe = await prisma.regraComissaoAfiliado.findFirst({ where: { afiliadoId: af.id, fonte: r.fonte } });
    if (existe) {
      console.log(`Regra de "${r.nome}" já cadastrada.`);
    } else {
      await prisma.regraComissaoAfiliado.create({
        data: {
          afiliadoId: af.id,
          valorFixoCentavos: r.fixoCentavos ?? null,
          percentualBps: r.percentualBps ?? null,
          vigenteDe: new Date('2026-09-01T00:00:00-03:00'),
          fonte: r.fonte,
          observacao: 'Comissão DO AFILIADO: só vale onde a fonte não traz o valor exato; não altera a comissão da operação.',
        },
      });
      console.log(`Regra criada: ${r.nome}, ${r.fixoCentavos ? `R$ ${(r.fixoCentavos / 100).toFixed(2)} fixos` : `${(r.percentualBps ?? 0) / 100}% da venda`}, vigente desde 01/09/2026.`);
    }
    console.log(`  comissões do afiliado recalculadas (somente sem valor exato da fonte): ${await recalcularComissoesPorRegra(af.id)}`);
    await prisma.auditoria.create({ data: { acao: 'admin.regras_iniciais', entidade: 'afiliado', entidadeId: af.id } });
  }
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
