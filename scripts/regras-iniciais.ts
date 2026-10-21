/**
 * Aplica as regras de negócio já DECIDIDAS pelo Elias (doc "Webhook da Pagah · como funciona", 16/10/2026).
 * Idempotente: pode rodar várias vezes. Uso: `npm run regras:iniciais`.
 *
 * 1. Payout do RedTrack = comissão exata (liga `redtrack.payoutComoComissao`).
 * 2. X1 = Pix sem valor líquido do vendedor 889739 (comissão 0 nos relatórios padrão).
 * 3. André Pinheiro: comissão DO AFILIADO fixa de R$ 240,00 por venda (o `afiliado_comissao` da Pagah vem 0).
 *    SOMENTE para ele: o valor não é universal para os demais afiliados.
 */
import { closeDatabase, prisma } from '../src/config/database';
import { recalcularComissoesPorRegra } from '../src/modules/afiliados/afiliados.service';
import { searchKey } from '../src/shared/utils/text';

const FONTE_ANDRE = 'Doc Pagah 16/10/2026 §5: afiliado_comissao vem 0; R$ 240 fixos = valor do André Pinheiro (289 de 294 vendas em set/2026)';

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

  const andre = await prisma.afiliado.findUnique({ where: { nomeBusca: searchKey('André Pinheiro')! } });
  if (!andre) {
    console.log('Afiliado "André Pinheiro" ainda não existe no banco (rode a sincronização antes); regra não criada.');
    return;
  }
  const existe = await prisma.regraComissaoAfiliado.findFirst({ where: { afiliadoId: andre.id, fonte: FONTE_ANDRE } });
  if (existe) {
    console.log('Regra do André Pinheiro já cadastrada.');
  } else {
    await prisma.regraComissaoAfiliado.create({
      data: {
        afiliadoId: andre.id,
        valorFixoCentavos: 24000,
        vigenteDe: new Date('2026-09-01T00:00:00-03:00'),
        fonte: FONTE_ANDRE,
        observacao: 'Comissão DO AFILIADO: só vale onde a fonte não traz o valor exato; não altera a comissão da operação.',
      },
    });
    console.log('Regra criada: André Pinheiro, R$ 240,00 fixos, vigente desde 01/09/2026.');
  }
  console.log(`Comissões do afiliado recalculadas (somente sem valor exato da fonte): ${await recalcularComissoesPorRegra(andre.id)}`);
  await prisma.auditoria.create({ data: { acao: 'admin.regras_iniciais', entidade: 'afiliado', entidadeId: andre.id } });
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
