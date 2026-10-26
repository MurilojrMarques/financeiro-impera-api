import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { rhConfigurado } from '../../integrations/rh-mysql/rh-mysql';
import { validate } from '../../middlewares/validate.middleware';
import { audit } from '../../shared/services/audit.service';
import { ok, pageMeta, paginated } from '../../shared/utils/response';
import { exigeRh, PAPEIS_VEEM_SALARIO } from './rh.access';
import { lerEstadoMonitor, monitorarOrigemRh } from './rh.monitor';

/**
 * Monitoramento da origem de verdade (sistema do RH). Aqui NÃO existe rota para alterar salário ou promoção: isso é feito só na origem
 * e chega a esta API pela sincronização. Só RH e CEO enxergam (os valores de salário aparecem nas alterações).
 */
export const monitoramentoRouter = Router();
/** O guard fica em cada rota (e não no router): este router está montado na raiz do /rh e não pode barrar as rotas de gestor/colaborador. */
const soRhCeo = exigeRh(PAPEIS_VEEM_SALARIO);

const alteracoesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  tipo: z.enum(['NOVO_COLABORADOR', 'SALARIO', 'CARGO', 'DEPARTAMENTO', 'GESTOR', 'DESLIGAMENTO', 'MOVIMENTACAO', 'REMOVIDO_DA_ORIGEM']).optional(),
  colaboradorId: z.string().uuid().optional(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

monitoramentoRouter.get('/monitoramento', soRhCeo, async (_req, res) => {
  const [estado, ultima, inconsistencias, contagens] = await Promise.all([
    lerEstadoMonitor(),
    prisma.rhSincronizacao.findFirst({ where: { status: 'SUCESSO' }, orderBy: { iniciadaEm: 'desc' } }),
    prisma.rhSincronizacao.findFirst({ where: { status: 'SUCESSO', inconsistencias: { gt: 0 } }, orderBy: { iniciadaEm: 'desc' }, select: { detalhes: true, id: true } }),
    prisma.rhAlteracao.groupBy({ by: ['tipo'], where: { detectadaEm: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true } }),
  ]);
  const verificadaEm = estado.ultimaVerificacaoEm ? new Date(estado.ultimaVerificacaoEm) : null;
  const defasadoMin = verificadaEm ? Math.round((Date.now() - verificadaEm.getTime()) / 60_000) : null;
  const intervalo = env.RH_SYNC_INTERVAL_MINUTES;
  const ultimaInconsistencia = ultima && ultima.id === inconsistencias?.id ? inconsistencias : null;
  ok(res, {
    monitoramentoLigado: env.RH_SYNC_ENABLED && rhConfigurado(),
    intervaloMinutos: intervalo,
    ultimaVerificacaoEm: estado.ultimaVerificacaoEm,
    ultimoStatus: estado.ultimoStatus,
    ultimoErro: estado.ultimoErro,
    falhasSeguidas: estado.falhasSeguidas,
    /** a conferência está atrasada (mais de 3 intervalos sem verificar) */
    atrasado: defasadoMin === null || defasadoMin > intervalo * 3,
    minutosDesdeAUltimaVerificacao: defasadoMin,
    origem: { salvaEm: estado.marca?.atualizadoEm ?? null, salvaPor: estado.marca?.atualizadoPor ?? null },
    ultimaSincronizacao: ultima ? { id: ultima.id, em: ultima.iniciadaEm, alteracoes: ultima.alteracoes, novos: ultima.novos, atualizados: ultima.atualizados } : null,
    /** pessoas cujo salário atual difere do último reajuste registrado na própria origem (dois valores para o mesmo salário) */
    inconsistenciasNaOrigem: ultimaInconsistencia ? ((ultimaInconsistencia.detalhes as { inconsistencias?: unknown[] } | null)?.inconsistencias ?? []) : [],
    alteracoesUltimos30Dias: Object.fromEntries(contagens.map((c) => [c.tipo, c._count._all])),
  });
});

monitoramentoRouter.get('/alteracoes', soRhCeo, validate({ query: alteracoesQuery }), async (req, res) => {
  const q = req.valid.query as ReturnType<typeof alteracoesQuery.parse>;
  const where = {
    ...(q.tipo ? { tipo: q.tipo } : {}),
    ...(q.colaboradorId ? { colaboradorId: q.colaboradorId } : {}),
    ...(q.desde ? { detectadaEm: { gte: new Date(`${q.desde}T00:00:00Z`) } } : {}),
  };
  const [total, itens] = await Promise.all([
    prisma.rhAlteracao.count({ where }),
    prisma.rhAlteracao.findMany({ where, orderBy: { detectadaEm: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  const nomes = new Map((await prisma.rhColaborador.findMany({ where: { id: { in: itens.map((i) => i.colaboradorId).filter((x): x is string => !!x) } }, select: { id: true, nome: true } })).map((c) => [c.id, c.nome]));
  await audit(req, 'rh.salario_consultado', 'rh_alteracao', undefined, { lista: true, quantidade: itens.length });
  paginated(res, itens.map((a) => ({ ...a, colaborador: a.colaboradorId ? { id: a.colaboradorId, nome: nomes.get(a.colaboradorId) ?? null } : null })), pageMeta(q.page, q.limit, total));
});

/** Confere a origem agora, sem esperar o próximo ciclo (lê só; nada é gravado na origem). */
monitoramentoRouter.post('/sincronizar', soRhCeo, async (req, res) => {
  const r = await monitorarOrigemRh('manual', { forcar: req.query.forcar === 'true' });
  await audit(req, 'rh.sincronizacao_manual', 'rh_sincronizacao', 'sincronizacaoId' in r ? r.sincronizacaoId : undefined, { situacao: r.situacao });
  ok(res, r);
});
