import { prisma } from '../../config/database';
import { Errors } from '../../shared/errors/app-error';
import { searchKey, cleanText } from '../../shared/utils/text';
import { comissaoPorRegra } from '../vendas/domain/comissao';

export async function obterAfiliado(id: string) {
  const a = await prisma.afiliado.findUnique({
    where: { id },
    select: { id: true, nome: true, criadoEm: true, _count: { select: { aliases: true, regras: true, vendas: true } } },
  });
  if (!a) throw Errors.notFound('Afiliado não encontrado');
  return a;
}

export function listarAliases(afiliadoId: string) {
  return prisma.afiliadoAlias.findMany({ where: { afiliadoId }, select: { id: true, alias: true, criadoEm: true }, orderBy: { alias: 'asc' } });
}

/**
 * Cadastra alias. Se já existir um afiliado criado automaticamente com exatamente esse nome normalizado,
 * ele é incorporado (vendas, aliases e regras migram) — decisão EXPLÍCITA do administrador, auditada.
 * Nomes apenas parecidos nunca são mesclados.
 */
export async function adicionarAlias(afiliadoId: string, aliasBruto: string) {
  await obterAfiliado(afiliadoId);
  const alias = cleanText(aliasBruto);
  const chave = searchKey(alias);
  if (!alias || !chave) throw Errors.validation([{ path: 'alias', message: 'alias vazio' }]);

  return prisma.$transaction(async (tx) => {
    const aliasExistente = await tx.afiliadoAlias.findUnique({ where: { aliasBusca: chave } });
    if (aliasExistente) throw Errors.conflict('Alias já cadastrado');
    const proprio = await tx.afiliado.findUnique({ where: { id: afiliadoId }, select: { nomeBusca: true } });
    if (proprio?.nomeBusca === chave) throw Errors.conflict('O alias é igual ao nome do próprio afiliado');

    let vendasMovidas = 0;
    const outro = await tx.afiliado.findUnique({ where: { nomeBusca: chave } });
    if (outro && outro.id !== afiliadoId) {
      vendasMovidas = (await tx.venda.updateMany({ where: { afiliadoId: outro.id }, data: { afiliadoId } })).count;
      await tx.afiliadoAlias.updateMany({ where: { afiliadoId: outro.id }, data: { afiliadoId } });
      await tx.regraComissaoAfiliado.updateMany({ where: { afiliadoId: outro.id }, data: { afiliadoId } });
      await tx.afiliado.delete({ where: { id: outro.id } });
    }
    const criado = await tx.afiliadoAlias.create({
      data: { afiliadoId, alias, aliasBusca: chave },
      select: { id: true, alias: true, criadoEm: true },
    });
    return { alias: criado, afiliadoIncorporado: outro && outro.id !== afiliadoId ? outro.nome : null, vendasMovidas };
  });
}

export async function removerAlias(afiliadoId: string, aliasId: string) {
  const r = await prisma.afiliadoAlias.deleteMany({ where: { id: aliasId, afiliadoId } });
  if (r.count === 0) throw Errors.notFound('Alias não encontrado');
}

export function listarRegrasComissao(afiliadoId: string) {
  return prisma.regraComissaoAfiliado.findMany({ where: { afiliadoId }, orderBy: { vigenteDe: 'desc' } });
}

export async function criarRegraComissao(
  afiliadoId: string,
  userId: string,
  b: { valorFixoCentavos?: number; percentualBps?: number; vigenteDe: string; vigenteAte?: string; fonte: string; observacao?: string },
) {
  await obterAfiliado(afiliadoId);
  const regra = await prisma.regraComissaoAfiliado.create({
    data: {
      afiliadoId,
      valorFixoCentavos: b.valorFixoCentavos ?? null,
      percentualBps: b.percentualBps ?? null,
      vigenteDe: new Date(b.vigenteDe),
      vigenteAte: b.vigenteAte ? new Date(b.vigenteAte) : null,
      fonte: b.fonte,
      observacao: b.observacao ?? null,
      criadoPorId: userId,
    },
  });
  const recalculadas = await recalcularComissoesPorRegra(afiliadoId);
  return { regra, vendasRecalculadas: recalculadas };
}

/**
 * Reaplica regras de comissão DO AFILIADO às vendas dele, mexendo SOMENTE onde não há valor exato da fonte
 * (AUSENTE ou REGRA_AFILIADO). A comissão da operação (o que a Impera recebe) nunca é tocada por estas regras.
 */
export async function recalcularComissoesPorRegra(afiliadoId: string): Promise<number> {
  const regras = await prisma.regraComissaoAfiliado.findMany({ where: { afiliadoId } });
  let alteradas = 0;
  let cursor: string | undefined;
  for (;;) {
    const vendas = await prisma.venda.findMany({
      where: { afiliadoId, comissaoAfiliadoFonte: { in: ['AUSENTE', 'REGRA_AFILIADO'] } },
      select: { id: true, valorVendaCentavos: true, pagoEm: true, comissaoAfiliadoCentavos: true, comissaoAfiliadoFonte: true },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (vendas.length === 0) break;
    for (const v of vendas) {
      const novo = comissaoPorRegra(v.valorVendaCentavos, v.pagoEm, regras);
      const fonte = novo === null ? 'AUSENTE' : 'REGRA_AFILIADO';
      if (novo !== v.comissaoAfiliadoCentavos || fonte !== v.comissaoAfiliadoFonte) {
        await prisma.venda.update({ where: { id: v.id }, data: { comissaoAfiliadoCentavos: novo, comissaoAfiliadoFonte: fonte } });
        alteradas++;
      }
    }
    cursor = vendas[vendas.length - 1].id;
  }
  return alteradas;
}
