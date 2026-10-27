import { Router } from 'express';
import { prisma } from '../../config/database';
import { comissaoCopyNoPeriodo, type ComissaoCopyPessoa } from '../../integrations/copy-supabase/copy-comissao';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { ok } from '../../shared/utils/response';
import { exigeRh, PAPEIS_ESCREVEM, veTodos } from './rh.access';
import { comissaoLancarBody, comissaoQuery, comissaoVinculoBody } from './rh.schemas';
import { limitesDoMes, totalDoItem } from './rh.service';

/**
 * Comissão do Front por colaborador (5% do MC BR de cada pessoa, lida do sistema de copy: ver copy-comissao.ts).
 * Só o Front: Call Center e Recuperação são por equipe e ficam fora até existir regra por pessoa.
 * O vínculo copywriter → colaborador do RH é decidido pelo RH (`rh_colaboradores.copywriterId`), porque os nomes não casam sozinhos.
 * RH e CEO veem todos; gestor e colaborador veem só a própria linha. Só o RH vincula e lança na folha.
 * Lançar na folha exige o mês FECHADO no copy (no aberto o valor é provisório) e a folha do mês ABERTA.
 */
export const comissoesRouter = Router();

const dia = (d: Date): string => d.toISOString().slice(0, 10);
const norm = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

async function apurar(competencia: string) {
  const { inicio, fim } = limitesDoMes(competencia);
  return comissaoCopyNoPeriodo(dia(inicio), dia(fim));
}

comissoesRouter.get('/', validate({ query: comissaoQuery }), async (req, res) => {
  const { competencia } = req.valid.query as { competencia: string };
  const todos = veTodos(req.user?.rhPapel);
  const proprio = req.user?.colaboradorId ?? null;
  if (!todos && !proprio) throw Errors.forbidden();

  const copy = await apurar(competencia);
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia }, include: { itens: { select: { colaboradorId: true, comissaoCentavos: true } } } });
  const base = { competencia, folha: folha ? { status: folha.status } : null };
  await audit(req, 'rh.comissoes_consultada', 'rh_comissoes', undefined, { competencia });
  if (!copy.disponivel) return ok(res, { ...base, disponivel: false, motivo: copy.motivo, mensagem: copy.mensagem, itens: [], sugestoes: {}, totais: null });

  const vinculados = await prisma.rhColaborador.findMany({ where: { copywriterId: { not: null } }, select: { id: true, nome: true, copywriterId: true } });
  const porCopy = new Map(vinculados.map((c) => [c.copywriterId!, c]));
  const lancado = new Map((folha?.itens ?? []).map((i) => [i.colaboradorId, i.comissaoCentavos]));

  const linha = (p: ComissaoCopyPessoa) => {
    const c = porCopy.get(p.copywriterId) ?? null;
    return {
      copywriterId: p.copywriterId,
      copywriterNome: p.nome,
      colaborador: c ? { id: c.id, nome: c.nome } : null,
      mcBrCentavos: p.mcBrCentavos,
      comissaoCentavos: p.comissaoCentavos,
      aPagarCentavos: p.aPagarCentavos,
      /** o que já está na folha deste colaborador (null = sem folha ou sem vínculo) */
      naFolhaCentavos: c ? (lancado.get(c.id) ?? null) : null,
    };
  };

  let itens = copy.pessoas.map(linha);
  if (!todos) itens = itens.filter((i) => i.colaborador?.id === proprio);

  // sugestões de vínculo (só para o RH): colaboradores ativos em que o nome do copywriter aparece como palavra do nome
  let sugestoes: Record<string, { id: string; nome: string }[]> = {};
  if (req.user?.rhPapel === 'RH') {
    const semVinculo = itens.filter((i) => !i.colaborador);
    if (semVinculo.length > 0) {
      const livres = await prisma.rhColaborador.findMany({ where: { copywriterId: null, demissao: null }, select: { id: true, nome: true }, orderBy: { nome: 'asc' } });
      sugestoes = Object.fromEntries(semVinculo.map((i) => [i.copywriterId, livres.filter((c) => norm(c.nome).split(/\s+/).includes(norm(i.copywriterNome)))]));
    }
  }

  ok(res, {
    ...base,
    disponivel: true,
    estado: copy.estado,
    itens,
    sugestoes,
    totais: todos
      ? {
          comissaoCentavos: copy.comissaoCentavos,
          aPagarCentavos: copy.aPagarCentavos,
          mcBrComissionavelCentavos: copy.mcBrComissionavelCentavos,
          semVinculo: itens.filter((i) => !i.colaborador).length,
        }
      : null,
  });
});

comissoesRouter.put('/vinculos', exigeRh(PAPEIS_ESCREVEM), validate({ body: comissaoVinculoBody }), async (req, res) => {
  const b = req.valid.body as { copywriterId: string; colaboradorId: string | null };
  if (b.colaboradorId) {
    const c = await prisma.rhColaborador.findUnique({ where: { id: b.colaboradorId }, select: { id: true } });
    if (!c) throw Errors.notFound('Colaborador não encontrado');
  }
  await prisma.$transaction([
    prisma.rhColaborador.updateMany({ where: { copywriterId: b.copywriterId }, data: { copywriterId: null } }),
    ...(b.colaboradorId ? [prisma.rhColaborador.update({ where: { id: b.colaboradorId }, data: { copywriterId: b.copywriterId } })] : []),
  ]);
  await audit(req, 'rh.comissao_vinculo', 'rh_colaborador', b.colaboradorId ?? undefined, { copywriterId: b.copywriterId, colaboradorId: b.colaboradorId });
  ok(res, { copywriterId: b.copywriterId, colaboradorId: b.colaboradorId });
});

comissoesRouter.post('/lancar', exigeRh(PAPEIS_ESCREVEM), validate({ body: comissaoLancarBody }), async (req, res) => {
  const { competencia } = req.valid.body as { competencia: string };
  const copy = await apurar(competencia);
  if (!copy.disponivel) throw Errors.conflict(copy.mensagem);
  if (copy.estado !== 'FECHADO') throw Errors.conflict('O mês ainda não está fechado no sistema de copy: a comissão é provisória e só pode ir para a folha depois do fechamento.');
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia }, include: { itens: true } });
  if (!folha) throw Errors.conflict(`A folha de ${competencia} ainda não foi gerada.`);
  if (folha.status === 'FECHADA') throw Errors.conflict('Folha fechada: não é possível alterar.');

  const vinculados = await prisma.rhColaborador.findMany({ where: { copywriterId: { not: null } }, select: { id: true, copywriterId: true } });
  const porCopy = new Map(vinculados.map((c) => [c.copywriterId!, c.id]));
  const itemDe = new Map(folha.itens.map((i) => [i.colaboradorId, i]));

  const aPagar = copy.pessoas.filter((p) => p.aPagarCentavos > 0);
  const semVinculo = aPagar.filter((p) => !porCopy.has(p.copywriterId)).map((p) => p.nome);
  if (semVinculo.length > 0) throw Errors.conflict(`Vincule ao colaborador antes de lançar: ${semVinculo.join(', ')}.`);
  const semItem = aPagar.filter((p) => !itemDe.has(porCopy.get(p.copywriterId)!)).map((p) => p.nome);
  if (semItem.length > 0) throw Errors.conflict(`Sem linha na folha de ${competencia}: ${semItem.join(', ')}. Gere a folha com essas pessoas ativas no mês.`);

  // quem tem vínculo recebe o valor apurado, inclusive zero (corrige um lançamento anterior); quem não tem vínculo não é tocado
  const alvos = copy.pessoas.filter((p) => porCopy.has(p.copywriterId) && itemDe.has(porCopy.get(p.copywriterId)!));
  let alterados = 0;
  await prisma.$transaction(
    alvos.map((p) => {
      const item = itemDe.get(porCopy.get(p.copywriterId)!)!;
      if (item.comissaoCentavos !== p.aPagarCentavos) alterados++;
      return prisma.rhFolhaItem.update({
        where: { id: item.id },
        data: { comissaoCentavos: p.aPagarCentavos, totalCentavos: totalDoItem({ ...item, comissaoCentavos: p.aPagarCentavos }) },
      });
    }),
  );
  const totalCentavos = alvos.reduce((s, p) => s + p.aPagarCentavos, 0);
  await audit(req, 'rh.comissoes_lancadas', 'rh_folha', folha.id, { competencia, pessoas: alvos.length, alterados, totalCentavos });
  ok(res, { competencia, pessoas: alvos.length, alterados, totalCentavos });
});
