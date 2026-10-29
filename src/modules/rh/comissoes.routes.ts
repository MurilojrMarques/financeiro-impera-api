import { Router } from 'express';
import { prisma } from '../../config/database';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, ok } from '../../shared/utils/response';
import { apurarFront, norm, VALOR_OTIMIZACAO_CENTAVOS, type BeneficiarioComissao } from '../comissoes/comissao-front';
import { exigeRh, PAPEIS_ESCREVEM, veTodos } from './rh.access';
import { comissaoLancarBody, comissaoQuery, comissaoVinculoBody, idParams, otimizacaoBody, otimizacaoQuery, vslBody } from './rh.schemas';
import { totalDoItem } from './rh.service';

/**
 * Comissão do time do Front por colaborador (regras e fonte de cada dado em ../comissoes/comissao-front.ts).
 * O vínculo beneficiário → colaborador do RH é decidido pelo RH (copywriterId para quem é do copy; comissaoChave para gestor, editor e fixo),
 * porque os nomes não casam sozinhos. A área é só do RH e do CEO (gestor e colaborador não veem comissão). Só o RH vincula, lança otimizações,
 * cadastra VSL e lança na folha. Lançar na folha exige o mês FECHADO no copy, o RedTrack respondendo, nenhuma VSL sem dono e a folha do mês ABERTA.
 */
export const comissoesRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** coluna do RH em que a chave fica guardada */
const colunaDe = (chave: string): 'copywriterId' | 'comissaoChave' => (UUID.test(chave) ? 'copywriterId' : 'comissaoChave');

/** sugestão de vínculo por nome: copywriter pelo apelido como palavra do nome; os demais pela palavra que os identifica */
const SUGESTAO: Record<string, RegExp> = {
  'EDITOR:MINEIRO': /\bigor paiva\b/,
  'FIXO:IAGO': /\biago\b/,
  'GESTOR:GREG': /\bgregori\b|\bgreg\b/,
  'GESTOR:LUCAS': /\blucas\b/,
  'GESTOR:JOAO': /\bjoao\b/,
};
const sugere = (i: BeneficiarioComissao, nomeColab: string): boolean => {
  const n = norm(nomeColab).toLowerCase();
  return i.tipo === 'COPYWRITER' ? n.split(/\s+/).includes(norm(i.nome).toLowerCase()) : (SUGESTAO[i.chave]?.test(n) ?? false);
};

comissoesRouter.get('/', validate({ query: comissaoQuery }), async (req, res) => {
  const { competencia } = req.valid.query as { competencia: string };
  if (!veTodos(req.user?.rhPapel)) throw Errors.forbidden();

  const r = await apurarFront(competencia);
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia }, include: { itens: { select: { colaboradorId: true, comissaoCentavos: true } } } });
  const base = { competencia, folha: folha ? { status: folha.status } : null };
  await audit(req, 'rh.comissoes_consultada', 'rh_comissoes', undefined, { competencia });
  if (!r.disponivel) return ok(res, { ...base, disponivel: false, motivo: r.motivo, mensagem: r.mensagem, itens: [], sugestoes: {}, totais: null, vsl: null });

  const vinculados = await prisma.rhColaborador.findMany({ where: { OR: [{ copywriterId: { not: null } }, { comissaoChave: { not: null } }] }, select: { id: true, nome: true, copywriterId: true, comissaoChave: true } });
  const porChave = new Map(vinculados.map((c) => [(c.copywriterId ?? c.comissaoChave)!, c]));
  const lancado = new Map((folha?.itens ?? []).map((i) => [i.colaboradorId, i.comissaoCentavos]));

  const linha = (i: BeneficiarioComissao) => {
    const c = porChave.get(i.chave) ?? null;
    return { ...i, colaborador: c ? { id: c.id, nome: c.nome } : null, /** o que já está na folha deste colaborador (null = sem folha ou sem vínculo) */ naFolhaCentavos: c ? (lancado.get(c.id) ?? null) : null };
  };
  const itens = r.itens.map(linha);

  let sugestoes: Record<string, { id: string; nome: string }[]> = {};
  if (req.user?.rhPapel === 'RH') {
    const semVinculo = itens.filter((i) => !i.colaborador);
    if (semVinculo.length > 0) {
      const livres = await prisma.rhColaborador.findMany({ where: { copywriterId: null, comissaoChave: null, demissao: null }, select: { id: true, nome: true }, orderBy: { nome: 'asc' } });
      sugestoes = Object.fromEntries(semVinculo.map((i) => [i.chave, livres.filter((c) => sugere(i, c.nome))]));
    }
  }

  ok(res, {
    ...base,
    disponivel: true,
    estado: r.estado,
    completa: r.completa,
    itens,
    sugestoes,
    vsl: { disponivel: r.vslDisponivel, mensagem: r.vslMensagem, semDono: r.vslSemDono },
    totais: {
      comissaoCentavos: r.totais.apuradaCentavos,
      aPagarCentavos: r.totais.aPagarCentavos,
      semVinculo: itens.filter((i) => i.status === 'CALCULADA' && !i.colaborador && (i.aPagarCentavos ?? 0) > 0).length,
      emImplementacao: itens.filter((i) => i.status === 'EM_IMPLEMENTACAO').length,
    },
  });
});

comissoesRouter.put('/vinculos', exigeRh(PAPEIS_ESCREVEM), validate({ body: comissaoVinculoBody }), async (req, res) => {
  const b = req.valid.body as { chave: string; colaboradorId: string | null };
  if (b.colaboradorId) {
    const c = await prisma.rhColaborador.findUnique({ where: { id: b.colaboradorId }, select: { id: true } });
    if (!c) throw Errors.notFound('Colaborador não encontrado');
  }
  const col = colunaDe(b.chave);
  await prisma.$transaction([
    prisma.rhColaborador.updateMany({ where: { [col]: b.chave }, data: { [col]: null } }),
    ...(b.colaboradorId ? [prisma.rhColaborador.update({ where: { id: b.colaboradorId }, data: { [col]: b.chave } })] : []),
  ]);
  await audit(req, 'rh.comissao_vinculo', 'rh_colaborador', b.colaboradorId ?? undefined, { chave: b.chave, colaboradorId: b.colaboradorId });
  ok(res, { chave: b.chave, colaboradorId: b.colaboradorId });
});

comissoesRouter.post('/lancar', exigeRh(PAPEIS_ESCREVEM), validate({ body: comissaoLancarBody }), async (req, res) => {
  const { competencia } = req.valid.body as { competencia: string };
  const r = await apurarFront(competencia);
  if (!r.disponivel) throw Errors.conflict(r.mensagem);
  if (r.estado !== 'FECHADO') throw Errors.conflict('O mês ainda não está fechado no sistema de copy: a comissão é provisória e só pode ir para a folha depois do fechamento.');
  if (!r.vslDisponivel) throw Errors.conflict(`Não foi possível ler as VSLs no RedTrack agora (${r.vslMensagem ?? 'sem resposta'}). Tente de novo para não lançar um valor incompleto.`);
  if (r.vslSemDono.length > 0) throw Errors.conflict(`Cadastre o dono das VSLs antes de lançar: ${r.vslSemDono.slice(0, 5).map((v) => v.vsl).join('; ')}${r.vslSemDono.length > 5 ? '…' : ''}.`);
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia }, include: { itens: true } });
  if (!folha) throw Errors.conflict(`A folha de ${competencia} ainda não foi gerada.`);
  if (folha.status === 'FECHADA') throw Errors.conflict('Folha fechada: não é possível alterar.');

  const vinculados = await prisma.rhColaborador.findMany({ where: { OR: [{ copywriterId: { not: null } }, { comissaoChave: { not: null } }] }, select: { id: true, copywriterId: true, comissaoChave: true } });
  const porChave = new Map(vinculados.map((c) => [(c.copywriterId ?? c.comissaoChave)!, c.id]));
  const itemDe = new Map(folha.itens.map((i) => [i.colaboradorId, i]));

  const calculadas = r.itens.filter((i) => i.status === 'CALCULADA');
  const aPagar = calculadas.filter((i) => (i.aPagarCentavos ?? 0) > 0);
  const semVinculo = aPagar.filter((i) => !porChave.has(i.chave)).map((i) => i.nome);
  if (semVinculo.length > 0) throw Errors.conflict(`Vincule ao colaborador antes de lançar: ${semVinculo.join(', ')}.`);
  const semItem = aPagar.filter((i) => !itemDe.has(porChave.get(i.chave)!)).map((i) => i.nome);
  if (semItem.length > 0) throw Errors.conflict(`Sem linha na folha de ${competencia}: ${semItem.join(', ')}. Gere a folha com essas pessoas ativas no mês.`);

  // quem tem vínculo recebe o valor apurado, inclusive zero (corrige um lançamento anterior); o que está em implementação e quem não tem vínculo não são tocados
  const alvos = calculadas.filter((i) => porChave.has(i.chave) && itemDe.has(porChave.get(i.chave)!));
  let alterados = 0;
  await prisma.$transaction(
    alvos.map((i) => {
      const item = itemDe.get(porChave.get(i.chave)!)!;
      const valor = i.aPagarCentavos ?? 0;
      if (item.comissaoCentavos !== valor) alterados++;
      return prisma.rhFolhaItem.update({ where: { id: item.id }, data: { comissaoCentavos: valor, totalCentavos: totalDoItem({ ...item, comissaoCentavos: valor }) } });
    }),
  );
  const totalCentavos = alvos.reduce((s, i) => s + (i.aPagarCentavos ?? 0), 0);
  await audit(req, 'rh.comissoes_lancadas', 'rh_folha', folha.id, { competencia, pessoas: alvos.length, alterados, totalCentavos });
  ok(res, { competencia, pessoas: alvos.length, alterados, totalCentavos });
});

// ── Otimizações validadas (R$ 500 cada): só o RH lança; RH e CEO veem ───────────────────────────────────────────────────────────
comissoesRouter.get('/otimizacoes', validate({ query: otimizacaoQuery }), async (req, res) => {
  if (!veTodos(req.user?.rhPapel)) throw Errors.forbidden();
  const { competencia } = req.valid.query as { competencia: string };
  ok(res, await prisma.comissaoOtimizacao.findMany({ where: { competencia }, orderBy: { criadoEm: 'asc' } }));
});

comissoesRouter.post('/otimizacoes', exigeRh(PAPEIS_ESCREVEM), validate({ body: otimizacaoBody }), async (req, res) => {
  const b = req.valid.body as { competencia: string; copywriter: string; descricao: string; valorCentavos?: number };
  const criada = await prisma.comissaoOtimizacao.create({
    data: { competencia: b.competencia, copywriter: norm(b.copywriter), descricao: b.descricao, valorCentavos: b.valorCentavos ?? VALOR_OTIMIZACAO_CENTAVOS, criadoPorId: req.user?.id ?? null },
  });
  await audit(req, 'rh.otimizacao_criada', 'comissao_otimizacao', criada.id, { competencia: b.competencia, copywriter: criada.copywriter, valorCentavos: criada.valorCentavos });
  created(res, criada);
});

comissoesRouter.delete('/otimizacoes/:id', exigeRh(PAPEIS_ESCREVEM), validate({ params: idParams }), async (req, res) => {
  const { id } = req.valid.params as { id: string };
  const o = await prisma.comissaoOtimizacao.findUnique({ where: { id } });
  if (!o) throw Errors.notFound('Otimização não encontrada');
  await prisma.comissaoOtimizacao.delete({ where: { id } });
  await audit(req, 'rh.otimizacao_removida', 'comissao_otimizacao', id, { competencia: o.competencia, copywriter: o.copywriter, valorCentavos: o.valorCentavos });
  ok(res, { id });
});

// ── Cadastro de VSL (dono e editor): decisão do negócio, não vem do RedTrack ─────────────────────────────────────────────────────
comissoesRouter.get('/vsl', async (req, res) => {
  if (!veTodos(req.user?.rhPapel)) throw Errors.forbidden();
  ok(res, await prisma.comissaoVsl.findMany({ orderBy: { chave: 'asc' } }));
});

comissoesRouter.put('/vsl', exigeRh(PAPEIS_ESCREVEM), validate({ body: vslBody }), async (req, res) => {
  const b = req.valid.body as { chave: string; dono: string | null; editor: string | null; mesmaVsl: string | null };
  const dados = { dono: b.dono ? norm(b.dono) : null, editor: b.editor ? norm(b.editor) : null, mesmaVsl: b.mesmaVsl, fonte: 'Cadastrado pelo RH no sistema' };
  const v = await prisma.comissaoVsl.upsert({ where: { chave: b.chave }, create: { chave: b.chave, ...dados }, update: dados });
  await audit(req, 'rh.vsl_cadastrada', 'comissao_vsl', v.id, { chave: v.chave, dono: v.dono, editor: v.editor, mesmaVsl: v.mesmaVsl });
  ok(res, v);
});
