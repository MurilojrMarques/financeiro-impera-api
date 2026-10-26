import { Router } from 'express';
import { prisma } from '../../config/database';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, ok } from '../../shared/utils/response';
import { exigeRh, PAPEIS_ESCREVEM, PAPEIS_VEEM_SALARIO } from './rh.access';
import { competenciaParams, folhaItemBody, itemParams } from './rh.schemas';
import { colaboradoresDoMes, limitesDoMes, salarioNaData, totalDoItem } from './rh.service';

/**
 * Folha de pagamento (PJ). Só RH e CEO enxergam; só o RH altera.
 * O valor pago é o SALÁRIO cadastrado (sem multiplicador de PJ, decisão de 26/10/2026) + comissão + bônus − desconto lançados à mão.
 * Comissão automática por colaborador ainda não existe: o campo é lançado manualmente.
 */
export const folhaRouter = Router();
folhaRouter.use(exigeRh(PAPEIS_VEEM_SALARIO));

const dia = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

function resumoDosItens(itens: { salarioCentavos: number; comissaoCentavos: number; bonusCentavos: number; descontoCentavos: number; totalCentavos: number; status: string }[]) {
  const soma = (f: (i: (typeof itens)[number]) => number) => itens.reduce((s, i) => s + f(i), 0);
  return {
    pessoas: itens.length,
    salariosCentavos: soma((i) => i.salarioCentavos),
    comissoesCentavos: soma((i) => i.comissaoCentavos),
    bonusCentavos: soma((i) => i.bonusCentavos),
    descontosCentavos: soma((i) => i.descontoCentavos),
    totalCentavos: soma((i) => i.totalCentavos),
    pagoCentavos: soma((i) => (i.status === 'PAGO' ? i.totalCentavos : 0)),
    pendenteCentavos: soma((i) => (i.status === 'PENDENTE' ? i.totalCentavos : 0)),
  };
}

folhaRouter.get('/', async (req, res) => {
  const comps = await prisma.rhFolhaCompetencia.findMany({ orderBy: { competencia: 'desc' }, include: { itens: true } });
  await audit(req, 'rh.folha_consultada', 'rh_folha');
  ok(res, comps.map((c) => ({ competencia: c.competencia, status: c.status, fechadaEm: c.fechadaEm, ...resumoDosItens(c.itens) })));
});

folhaRouter.get('/:competencia', validate({ params: competenciaParams }), async (req, res) => {
  const competencia = req.valid.params.competencia as string;
  const c = await prisma.rhFolhaCompetencia.findUnique({
    where: { competencia },
    include: { itens: { include: { colaborador: { select: { id: true, nome: true, departamento: true, funcao: true, cnpj: true } } }, orderBy: { colaborador: { nome: 'asc' } } } },
  });
  if (!c) throw Errors.notFound('Folha deste mês ainda não foi gerada');
  await audit(req, 'rh.folha_consultada', 'rh_folha', c.id, { competencia });
  ok(res, { competencia: c.competencia, status: c.status, fechadaEm: c.fechadaEm, resumo: resumoDosItens(c.itens), itens: c.itens });
});

/** Gera a folha do mês: uma linha por colaborador que estava ativo no mês, com o salário vigente no fim do mês. Pode rodar de novo: só inclui quem faltar. */
folhaRouter.post('/:competencia/gerar', exigeRh(PAPEIS_ESCREVEM), validate({ params: competenciaParams }), async (req, res) => {
  const competencia = req.valid.params.competencia as string;
  const { fim } = limitesDoMes(competencia);
  const existente = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia } });
  if (existente?.status === 'FECHADA') throw Errors.conflict('Folha fechada: não é possível alterar');
  const pessoas = await colaboradoresDoMes(competencia);
  const comp = existente ?? (await prisma.rhFolhaCompetencia.create({ data: { competencia } }));
  const jaTem = new Set((await prisma.rhFolhaItem.findMany({ where: { competenciaId: comp.id }, select: { colaboradorId: true } })).map((i) => i.colaboradorId));
  const novos = pessoas.filter((p) => !jaTem.has(p.id));
  if (novos.length > 0) {
    await prisma.rhFolhaItem.createMany({
      data: novos.map((p) => {
        const salario = salarioNaData(p.salarioCentavos, p.movimentacoes, fim);
        return { competenciaId: comp.id, colaboradorId: p.id, salarioCentavos: salario, totalCentavos: salario };
      }),
    });
  }
  await audit(req, 'rh.folha_gerada', 'rh_folha', comp.id, { competencia, incluidos: novos.length, total: pessoas.length });
  created(res, { competencia, status: comp.status, incluidos: novos.length, pessoas: pessoas.length });
});

folhaRouter.patch('/:competencia/itens/:itemId', exigeRh(PAPEIS_ESCREVEM), validate({ params: itemParams, body: folhaItemBody }), async (req, res) => {
  const { competencia, itemId } = req.valid.params as { competencia: string; itemId: string };
  const b = req.valid.body as ReturnType<typeof folhaItemBody.parse>;
  const item = await prisma.rhFolhaItem.findFirst({ where: { id: itemId, competencia: { competencia } }, include: { competencia: true } });
  if (!item) throw Errors.notFound('Item da folha não encontrado');
  const soPagamento = Object.keys(b).every((k) => k === 'status' || k === 'pagoEm' || k === 'obs');
  if (item.competencia.status === 'FECHADA' && !soPagamento) throw Errors.conflict('Folha fechada: só o pagamento pode ser registrado');
  const novo = {
    comissaoCentavos: b.comissaoCentavos ?? item.comissaoCentavos,
    bonusCentavos: b.bonusCentavos ?? item.bonusCentavos,
    descontoCentavos: b.descontoCentavos ?? item.descontoCentavos,
  };
  const total = totalDoItem({ salarioCentavos: item.salarioCentavos, ...novo });
  if (total < 0) throw Errors.validation([{ path: 'descontoCentavos', message: 'O desconto não pode deixar o total negativo' }]);
  const status = b.status ?? item.status;
  const atualizado = await prisma.rhFolhaItem.update({
    where: { id: itemId },
    data: {
      ...novo,
      totalCentavos: total,
      status,
      pagoEm: status === 'PAGO' ? (b.pagoEm ? dia(b.pagoEm) : (item.pagoEm ?? new Date())) : null,
      ...(b.obs !== undefined ? { obs: b.obs } : {}),
    },
  });
  await audit(req, 'rh.folha_item_alterado', 'rh_folha_item', itemId, { competencia, campos: Object.keys(b), total });
  ok(res, atualizado);
});

folhaRouter.post('/:competencia/fechar', exigeRh(PAPEIS_ESCREVEM), validate({ params: competenciaParams }), async (req, res) => {
  const competencia = req.valid.params.competencia as string;
  const c = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia }, include: { _count: { select: { itens: true } } } });
  if (!c) throw Errors.notFound('Folha deste mês ainda não foi gerada');
  if (c.status === 'FECHADA') throw Errors.conflict('Folha já está fechada');
  if (c._count.itens === 0) throw Errors.conflict('Folha sem itens');
  const f = await prisma.rhFolhaCompetencia.update({ where: { id: c.id }, data: { status: 'FECHADA', fechadaEm: new Date(), fechadaPorId: req.user!.id } });
  await audit(req, 'rh.folha_fechada', 'rh_folha', c.id, { competencia });
  ok(res, { competencia: f.competencia, status: f.status, fechadaEm: f.fechadaEm });
});
