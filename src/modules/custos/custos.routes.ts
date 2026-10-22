import { Router } from 'express';
import multer from 'multer';
import { env } from '../../config/env';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, noContent, ok, pageMeta, paginated } from '../../shared/utils/response';
import { resolverFiltro, filtrosSchema, type FiltrosQuery } from '../../shared/validators/filtros';
import { metaFinanceira } from '../../shared/services/relatorio.service';
import {
  anexoParams, atualizarCategoriaBody, atualizarCustoBody, criarCategoriaBody, criarCustoBody,
  criarRecorrenciaBody, idParams, listaQuery,
} from './custos.schemas';
import { custosService as svc } from './custos.service';

export const custosRouter = Router();
custosRouter.use(authenticate(), authorize(Roles.FINANCEIRO));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1 },
});

// ── estáticas antes das dinâmicas
custosRouter.get('/', validate({ query: listaQuery }), async (req, res) => {
  const q = req.valid.query;
  const { total, items } = await svc.listar(q);
  paginated(res, items, pageMeta(q.page, q.limit, total));
});

custosRouter.post('/', validate({ body: criarCustoBody }), async (req, res) => {
  const c = await svc.criar(req.user!.id, req.valid.body);
  await audit(req, 'custo.criado', 'custo', c.id, { valorCentavos: c.valorCentavos });
  created(res, c);
});

custosRouter.get('/resumo', validate({ query: filtrosSchema }), async (req, res) => {
  const f = resolverFiltro(req.valid.query as FiltrosQuery);
  ok(res, await svc.resumo(f), await metaFinanceira(f));
});

custosRouter.get('/categorias', async (_req, res) => ok(res, await svc.listarCategorias()));
custosRouter.post('/categorias', validate({ body: criarCategoriaBody }), async (req, res) => {
  const c = await svc.criarCategoria(req.valid.body.nome);
  await audit(req, 'custo.categoria_criada', 'categoria_custo', c.id);
  created(res, c);
});
custosRouter.patch('/categorias/:id', validate({ params: idParams, body: atualizarCategoriaBody }), async (req, res) => {
  const c = await svc.atualizarCategoria(req.valid.params.id, req.valid.body);
  await audit(req, 'custo.categoria_atualizada', 'categoria_custo', c.id, req.valid.body);
  ok(res, c);
});

custosRouter.get('/recorrencias', async (_req, res) => ok(res, await svc.listarRecorrencias()));
custosRouter.post('/recorrencias', validate({ body: criarRecorrenciaBody }), async (req, res) => {
  created(res, await svc.criarRecorrencia(req.valid.body));
});

// ── dinâmicas
custosRouter.get('/:id', validate({ params: idParams }), async (req, res) => ok(res, await svc.obter(req.valid.params.id)));
custosRouter.patch('/:id', validate({ params: idParams, body: atualizarCustoBody }), async (req, res) => {
  const c = await svc.atualizar(req.valid.params.id, req.valid.body);
  await audit(req, 'custo.atualizado', 'custo', c.id, req.valid.body);
  ok(res, c);
});
custosRouter.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await svc.remover(req.valid.params.id);
  await audit(req, 'custo.removido', 'custo', req.valid.params.id);
  noContent(res);
});

custosRouter.post('/:id/anexos', validate({ params: idParams }), upload.single('arquivo'), async (req, res) => {
  if (!req.file) throw Errors.validation([{ path: 'arquivo', message: 'campo "arquivo" obrigatório' }]);
  const a = await svc.adicionarAnexo(req.valid.params.id, req.file);
  await audit(req, 'custo.anexo_adicionado', 'custo', req.valid.params.id, { anexoId: a.id, mime: a.mime });
  created(res, a);
});
custosRouter.get('/:id/anexos', validate({ params: idParams }), async (req, res) => ok(res, await svc.listarAnexos(req.valid.params.id)));
custosRouter.get('/:id/anexos/:anexoId/download', validate({ params: anexoParams }), async (req, res) => {
  const { anexo, conteudo } = await svc.lerAnexo(req.valid.params.id, req.valid.params.anexoId);
  res.setHeader('Content-Type', anexo.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${anexo.nomeOriginal.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(anexo.nomeOriginal)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(conteudo);
});
custosRouter.delete('/:id/anexos/:anexoId', validate({ params: anexoParams }), async (req, res) => {
  await svc.removerAnexo(req.valid.params.id, req.valid.params.anexoId);
  await audit(req, 'custo.anexo_removido', 'custo', req.valid.params.id, { anexoId: req.valid.params.anexoId });
  noContent(res);
});
