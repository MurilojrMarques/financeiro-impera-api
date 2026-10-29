import { Router } from 'express';
import { prisma } from '../../config/database';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, ok } from '../../shared/utils/response';
import { exigeRh, PAPEIS_ESCREVEM, PAPEIS_VEEM_SALARIO } from './rh.access';
import { idParams, imperaCredBody, imperaCredQuery } from './rh.schemas';
import { aplicarImperaCredNaFolha, competenciaSeguinte } from './rh.service';

/**
 * ImperaCred = adiantamento de salário. O RH lança no mês em que a pessoa recebeu o adiantamento; a folha do MÊS SEGUINTE desconta o valor
 * inteiro (recebe 5.000, adianta 2.500 em outubro => em novembro recebe 2.500). A folha soma sozinha ao ser gerada, e uma folha já gerada e
 * ABERTA é atualizada na hora; folha fechada não muda, então lançar ou apagar um ImperaCred cujo desconto cairia nela é barrado.
 * RH e CEO veem; só o RH lança e apaga. Um adiantamento não passa do salário mensal da pessoa (somando os do mesmo mês).
 */
export const imperaCredRouter = Router();
imperaCredRouter.use(exigeRh(PAPEIS_VEEM_SALARIO));

async function folhaDoDesconto(competenciaDoAdiantamento: string) {
  const descontaEm = competenciaSeguinte(competenciaDoAdiantamento);
  const folha = await prisma.rhFolhaCompetencia.findUnique({ where: { competencia: descontaEm }, select: { status: true } });
  return { descontaEm, status: folha?.status ?? null };
}

imperaCredRouter.get('/', validate({ query: imperaCredQuery }), async (req, res) => {
  const { competencia } = req.valid.query as { competencia: string };
  const [itens, folha] = await Promise.all([
    prisma.rhImperaCred.findMany({ where: { competencia }, include: { colaborador: { select: { id: true, nome: true, departamento: true } } }, orderBy: { criadoEm: 'asc' } }),
    folhaDoDesconto(competencia),
  ]);
  await audit(req, 'rh.imperacred_consultado', 'rh_impera_cred', undefined, { competencia });
  ok(res, { competencia, descontaEm: folha.descontaEm, folhaDoDesconto: folha.status ? { status: folha.status } : null, totalCentavos: itens.reduce((s, i) => s + i.valorCentavos, 0), itens });
});

imperaCredRouter.post('/', exigeRh(PAPEIS_ESCREVEM), validate({ body: imperaCredBody }), async (req, res) => {
  const b = req.valid.body as { colaboradorId: string; competencia: string; valorCentavos: number; observacao?: string };
  const colab = await prisma.rhColaborador.findUnique({ where: { id: b.colaboradorId }, select: { id: true, salarioCentavos: true, demissao: true } });
  if (!colab) throw Errors.notFound('Colaborador não encontrado');
  const folha = await folhaDoDesconto(b.competencia);
  if (folha.status === 'FECHADA') throw Errors.conflict(`A folha de ${folha.descontaEm}, que descontaria este ImperaCred, já está fechada.`);
  const jaAdiantado = (await prisma.rhImperaCred.aggregate({ where: { colaboradorId: b.colaboradorId, competencia: b.competencia }, _sum: { valorCentavos: true } }))._sum.valorCentavos ?? 0;
  if (jaAdiantado + b.valorCentavos > colab.salarioCentavos) {
    throw Errors.validation([{ path: 'valorCentavos', message: 'O adiantamento (somado aos do mesmo mês) não pode passar do salário mensal da pessoa' }]);
  }
  const criado = await prisma.rhImperaCred.create({ data: { colaboradorId: b.colaboradorId, competencia: b.competencia, valorCentavos: b.valorCentavos, observacao: b.observacao ?? null, criadoPorId: req.user?.id ?? null } });
  await aplicarImperaCredNaFolha(folha.descontaEm, b.colaboradorId);
  await audit(req, 'rh.imperacred_lancado', 'rh_impera_cred', criado.id, { competencia: b.competencia, descontaEm: folha.descontaEm, colaboradorId: b.colaboradorId, valorCentavos: b.valorCentavos });
  created(res, { ...criado, descontaEm: folha.descontaEm });
});

imperaCredRouter.delete('/:id', exigeRh(PAPEIS_ESCREVEM), validate({ params: idParams }), async (req, res) => {
  const { id } = req.valid.params as { id: string };
  const item = await prisma.rhImperaCred.findUnique({ where: { id } });
  if (!item) throw Errors.notFound('ImperaCred não encontrado');
  const folha = await folhaDoDesconto(item.competencia);
  if (folha.status === 'FECHADA') throw Errors.conflict(`A folha de ${folha.descontaEm} já está fechada e já descontou este ImperaCred.`);
  await prisma.rhImperaCred.delete({ where: { id } });
  await aplicarImperaCredNaFolha(folha.descontaEm, item.colaboradorId);
  await audit(req, 'rh.imperacred_removido', 'rh_impera_cred', id, { competencia: item.competencia, descontaEm: folha.descontaEm, colaboradorId: item.colaboradorId, valorCentavos: item.valorCentavos });
  ok(res, { id });
});
