import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request } from 'express';
import multer from 'multer';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import type { Prisma } from '../../generated/prisma/client';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, ok, pageMeta, paginated } from '../../shared/utils/response';
import { alcanceDe, escreve, exigeRh, PAPEIS_ESCREVEM, veTodos } from './rh.access';
import { docListQuery, docStatusBody, docUploadBody, idParams } from './rh.schemas';
import { documentosDir } from './rh.storage';

/**
 * Documentos: NF enviada pelo colaborador, comprovante de pagamento, contrato.
 *  - RH: envia qualquer tipo para qualquer colaborador; aprova/reprova. RH e CEO listam e baixam tudo.
 *  - Qualquer outro papel: envia só a PRÓPRIA nota fiscal e vê/baixa só os próprios documentos (inclusive o comprovante que o RH enviou).
 */
export const documentosRouter = Router();

/** Tipos aceitos, conferidos pelo CONTEÚDO do arquivo (não pelo nome nem pelo tipo informado pelo navegador). */
function tipoDoConteudo(b: Buffer): { mime: string; ext: string } | null {
  if (b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.RH_DOC_MAX_BYTES, files: 1 } });

documentosRouter.post('/', upload.single('arquivo'), validate({ body: docUploadBody }), async (req, res) => {
  const b = req.valid.body as ReturnType<typeof docUploadBody.parse>;
  const papel = req.user!.rhPapel;
  const ehRh = escreve(papel);
  const proprio = req.user!.colaboradorId;
  let colaboradorId: string;
  if (ehRh) {
    if (!b.colaboradorId) throw Errors.validation([{ path: 'colaboradorId', message: 'Informe o colaborador' }]);
    colaboradorId = b.colaboradorId;
  } else {
    if (!proprio) throw Errors.forbidden();
    if (b.tipo !== 'NOTA_FISCAL') throw Errors.forbidden('Você só pode enviar a sua nota fiscal');
    if (b.colaboradorId && b.colaboradorId !== proprio) throw Errors.forbidden();
    colaboradorId = proprio;
  }
  if (!req.file) throw Errors.validation([{ path: 'arquivo', message: 'Envie o arquivo (campo "arquivo")' }]);
  const tipo = tipoDoConteudo(req.file.buffer);
  if (!tipo) throw Errors.validation([{ path: 'arquivo', message: 'Formato não aceito: envie PDF, PNG, JPG ou WEBP' }]);
  if (!(await prisma.rhColaborador.findUnique({ where: { id: colaboradorId }, select: { id: true } }))) throw Errors.notFound('Colaborador não encontrado');

  const pasta = path.join(documentosDir(), colaboradorId);
  const nome = `${randomUUID()}.${tipo.ext}`;
  await mkdir(pasta, { recursive: true });
  await writeFile(path.join(pasta, nome), req.file.buffer);
  const original = path.basename(req.file.originalname || `documento.${tipo.ext}`).replace(/[^\w.\- ()À-ÿ]/g, '_').slice(0, 150);
  const doc = await prisma.rhDocumento.create({
    data: {
      colaboradorId,
      tipo: b.tipo,
      competencia: b.competencia ?? null,
      valorCentavos: b.valorCentavos ?? null,
      descricao: b.descricao ?? null,
      arquivoNome: original,
      arquivoCaminho: path.join(colaboradorId, nome),
      mime: tipo.mime,
      tamanhoBytes: req.file.size,
      sha256: createHash('sha256').update(req.file.buffer).digest('hex'),
      enviadoPorId: req.user!.id,
    },
    select: { id: true, colaboradorId: true, tipo: true, competencia: true, valorCentavos: true, arquivoNome: true, mime: true, tamanhoBytes: true, status: true, criadoEm: true },
  });
  await audit(req, 'rh.documento_enviado', 'rh_documento', doc.id, { tipo: b.tipo, colaboradorId, competencia: b.competencia });
  created(res, doc);
});

documentosRouter.get('/', validate({ query: docListQuery }), async (req, res) => {
  const q = req.valid.query as ReturnType<typeof docListQuery.parse>;
  const alcance = await alcanceDe(req);
  const where: Prisma.RhDocumentoWhereInput = {
    ...(veTodos(req.user!.rhPapel) ? (q.colaboradorId ? { colaboradorId: q.colaboradorId } : {}) : { colaboradorId: req.user!.colaboradorId ?? '00000000-0000-0000-0000-000000000000' }),
    ...(q.competencia ? { competencia: q.competencia } : {}),
    ...(q.tipo ? { tipo: q.tipo } : {}),
    ...(q.status ? { status: q.status } : {}),
  };
  void alcance;
  const [total, itens] = await Promise.all([
    prisma.rhDocumento.count({ where }),
    prisma.rhDocumento.findMany({
      where,
      orderBy: { criadoEm: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: { id: true, colaboradorId: true, tipo: true, competencia: true, valorCentavos: true, descricao: true, arquivoNome: true, mime: true, tamanhoBytes: true, status: true, motivoReprovacao: true, criadoEm: true, colaborador: { select: { nome: true } } },
    }),
  ]);
  paginated(res, itens, pageMeta(q.page, q.limit, total));
});

async function documentoVisivel(req: Request, id: string) {
  const doc = await prisma.rhDocumento.findUnique({ where: { id } });
  const meu = req.user!.colaboradorId;
  if (!doc || !(veTodos(req.user!.rhPapel) || (meu && doc.colaboradorId === meu))) throw Errors.notFound('Documento não encontrado');
  return doc;
}

documentosRouter.get('/:id/arquivo', validate({ params: idParams }), async (req, res) => {
  const doc = await documentoVisivel(req, req.valid.params.id as string);
  const arquivo = path.join(documentosDir(), doc.arquivoCaminho);
  if (!arquivo.startsWith(documentosDir() + path.sep)) throw Errors.notFound('Documento não encontrado');
  const info = await stat(arquivo).catch(() => null);
  if (!info) throw Errors.notFound('Arquivo não encontrado no armazenamento');
  await audit(req, 'rh.documento_baixado', 'rh_documento', doc.id);
  const ascii = doc.arquivoNome.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Length', String(info.size));
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.arquivoNome)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  createReadStream(arquivo).pipe(res);
});

documentosRouter.patch('/:id/status', exigeRh(PAPEIS_ESCREVEM), validate({ params: idParams, body: docStatusBody }), async (req, res) => {
  const id = req.valid.params.id as string;
  const b = req.valid.body as ReturnType<typeof docStatusBody.parse>;
  if (!(await prisma.rhDocumento.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound('Documento não encontrado');
  const d = await prisma.rhDocumento.update({
    where: { id },
    data: { status: b.status, motivoReprovacao: b.status === 'REPROVADO' ? (b.motivo ?? null) : null, revisadoPorId: req.user!.id, revisadoEm: new Date() },
    select: { id: true, status: true, motivoReprovacao: true, revisadoEm: true },
  });
  await audit(req, 'rh.documento_revisado', 'rh_documento', id, { status: b.status });
  ok(res, d);
});
