import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { ok, pageMeta, paginated } from '../../shared/utils/response';

export const adminRouter = Router();
adminRouter.use(authenticate(), authorize(Roles.ADMIN));

export const auditoriaQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  acao: z.string().trim().max(80).optional(),
  usuarioId: z.string().uuid().optional(),
  de: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
});

adminRouter.get('/auditoria', validate({ query: auditoriaQuery }), async (req, res) => {
  const { page, limit, acao, usuarioId, de, ate } = req.valid.query;
  const where = {
    ...(acao ? { acao: { startsWith: acao } } : {}),
    ...(usuarioId ? { usuarioId } : {}),
    ...(de || ate ? { criadoEm: { ...(de ? { gte: new Date(de) } : {}), ...(ate ? { lte: new Date(ate) } : {}) } } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.auditoria.count({ where }),
    prisma.auditoria.findMany({
      where, orderBy: { criadoEm: 'desc' }, skip: (page - 1) * limit, take: limit,
      select: { id: true, acao: true, entidade: true, entidadeId: true, detalhes: true, ip: true, criadoEm: true, usuario: { select: { id: true, nome: true, email: true } } },
    }),
  ]);
  paginated(res, items, pageMeta(page, limit, total));
});

adminRouter.get('/metricas', async (_req, res) => {
  const desde = new Date(Date.now() - 86_400_000);
  const [vendas, eventos, usuarios, sessoesAtivas, errosUltimas24h, naoClassificadas, ultimas] = await Promise.all([
    prisma.venda.count(),
    prisma.vendaEvento.count(),
    prisma.usuario.count({ where: { ativo: true } }),
    prisma.sessao.count({ where: { revogadaEm: null, expiraEm: { gt: new Date() } } }),
    prisma.erroImportacao.count({ where: { criadoEm: { gte: desde } } }),
    prisma.venda.count({ where: { grupo: 'NAO_CLASSIFICADA' } }),
    prisma.sincronizacao.findMany({ orderBy: { iniciadaEm: 'desc' }, take: 5, select: { fonte: true, status: true, iniciadaEm: true, duracaoMs: true } }),
  ]);
  const mem = process.memoryUsage();
  ok(res, {
    banco: { vendas, eventos, usuariosAtivos: usuarios, sessoesAtivas, vendasNaoClassificadas: naoClassificadas },
    integracao: { errosUltimas24h: errosUltimas24h, ultimasExecucoes: ultimas },
    processo: { uptimeSegundos: Math.round(process.uptime()), memoriaRssMb: Math.round(mem.rss / 1048576), node: process.version },
  });
});
