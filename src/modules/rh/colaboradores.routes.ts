import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { prisma } from '../../config/database';
import { Prisma } from '../../generated/prisma/client';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { ok, pageMeta, paginated } from '../../shared/utils/response';
import { alcanceDe, exigeRh, PAPEIS_VEEM_SALARIO, podeVer, serializarColaborador, visaoDe } from './rh.access';
import { idParams, listQuery } from './rh.schemas';
import { fotosDir } from './rh.storage';

export const colaboradoresRouter = Router();

const comGestor = { gestor: { select: { id: true, nome: true } } } as const;

/** O cadastro do próprio usuário logado. */
colaboradoresRouter.get('/eu', async (req, res) => {
  const id = req.user!.colaboradorId;
  if (!id) throw Errors.notFound('Este login não está ligado a um colaborador');
  const c = await prisma.rhColaborador.findUnique({ where: { id }, include: comGestor });
  if (!c) throw Errors.notFound('Colaborador não encontrado');
  await audit(req, 'rh.salario_consultado', 'rh_colaborador', c.id, { proprio: true });
  ok(res, { papel: req.user!.rhPapel, colaborador: serializarColaborador(c, { salario: true, pessoais: true }) });
});

colaboradoresRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const q = req.valid.query as ReturnType<typeof listQuery.parse>;
  const alcance = await alcanceDe(req);
  const filtros: Prisma.RhColaboradorWhereInput[] = [];
  if (alcance.tipo === 'EQUIPE') filtros.push({ id: { in: [alcance.proprio, ...alcance.ids] } });
  if (alcance.tipo === 'PROPRIO') filtros.push({ id: alcance.proprio });
  if (q.departamento) filtros.push({ departamento: q.departamento });
  if (q.gestorId) filtros.push({ gestorId: q.gestorId });
  if (q.ativo !== undefined) filtros.push(q.ativo ? { demissao: null } : { demissao: { not: null } });
  if (q.busca) filtros.push({ OR: [{ nome: { contains: q.busca, mode: 'insensitive' } }, { funcao: { contains: q.busca, mode: 'insensitive' } }, { email: { contains: q.busca, mode: 'insensitive' } }] });
  const where: Prisma.RhColaboradorWhereInput = { AND: filtros };
  const [total, itens] = await Promise.all([
    prisma.rhColaborador.count({ where }),
    prisma.rhColaborador.findMany({ where, include: comGestor, orderBy: { nome: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  const dados = itens.map((c) => serializarColaborador(c, visaoDe(alcance, c.id)));
  if (dados.some((d) => 'salarioCentavos' in d)) await audit(req, 'rh.salario_consultado', 'rh_colaborador', undefined, { lista: true, quantidade: dados.length });
  paginated(res, dados, pageMeta(q.page, q.limit, total));
});

/** Painel da folha (RH e CEO): quanto a Impera paga por mês em salários, por departamento e senioridade. */
colaboradoresRouter.get('/painel', exigeRh(PAPEIS_VEEM_SALARIO), async (req, res) => {
  const ativos = await prisma.rhColaborador.findMany({ where: { demissao: null }, select: { departamento: true, senioridade: true, salarioCentavos: true } });
  const desligados = await prisma.rhColaborador.count({ where: { demissao: { not: null } } });
  const soma = (xs: { salarioCentavos: number }[]) => xs.reduce((s, x) => s + x.salarioCentavos, 0);
  const agrupa = (chave: (x: (typeof ativos)[number]) => string) => {
    const m = new Map<string, { quantidade: number; folhaCentavos: number }>();
    for (const a of ativos) {
      const k = chave(a);
      const g = m.get(k) ?? { quantidade: 0, folhaCentavos: 0 };
      g.quantidade += 1;
      g.folhaCentavos += a.salarioCentavos;
      m.set(k, g);
    }
    return [...m.entries()].map(([nome, g]) => ({ nome, ...g, mediaCentavos: Math.round(g.folhaCentavos / g.quantidade) })).sort((a, b) => b.folhaCentavos - a.folhaCentavos);
  };
  const desde = new Date(Date.now() - 90 * 86_400_000);
  const movs = await prisma.rhMovimentacao.findMany({ where: { data: { gte: desde } }, select: { tipo: true, salarioAnteriorCentavos: true, salarioNovoCentavos: true } });
  await audit(req, 'rh.painel_consultado', 'rh_painel');
  ok(res, {
    ativos: ativos.length,
    desligados,
    folhaMensalCentavos: soma(ativos),
    mediaSalarialCentavos: ativos.length ? Math.round(soma(ativos) / ativos.length) : 0,
    /** a Impera paga o salário cadastrado (sem multiplicador); o custo total com encargos de PJ ainda não é calculado */
    baseDaFolha: 'SALARIO',
    porDepartamento: agrupa((a) => a.departamento),
    porSenioridade: agrupa((a) => a.senioridade ?? 'sem senioridade'),
    ultimos90Dias: {
      movimentacoes: movs.length,
      promocoes: movs.filter((m) => m.tipo === 'PROMOCAO').length,
      reajustes: movs.filter((m) => m.tipo === 'REAJUSTE').length,
      aumentoMensalCentavos: movs.reduce((s, m) => s + (m.salarioNovoCentavos - m.salarioAnteriorCentavos), 0),
    },
  });
});

colaboradoresRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const id = req.valid.params.id as string;
  const alcance = await alcanceDe(req);
  if (!podeVer(alcance, id)) throw Errors.notFound('Colaborador não encontrado');
  const c = await prisma.rhColaborador.findUnique({ where: { id }, include: { ...comGestor, _count: { select: { equipe: true } } } });
  if (!c) throw Errors.notFound('Colaborador não encontrado');
  const v = visaoDe(alcance, id);
  if (v.salario) await audit(req, 'rh.salario_consultado', 'rh_colaborador', id);
  ok(res, { ...serializarColaborador(c, v), tamanhoDaEquipe: c._count.equipe });
});

colaboradoresRouter.get('/:id/foto', validate({ params: idParams }), async (req, res) => {
  const id = req.valid.params.id as string;
  const alcance = await alcanceDe(req);
  if (!podeVer(alcance, id)) throw Errors.notFound('Colaborador não encontrado');
  const c = await prisma.rhColaborador.findUnique({ where: { id }, select: { fotoArquivo: true } });
  if (!c?.fotoArquivo) throw Errors.notFound('Sem foto');
  const arquivo = path.join(fotosDir(), path.basename(c.fotoArquivo)); // basename: nunca sai da pasta
  const info = await stat(arquivo).catch(() => null);
  if (!info) throw Errors.notFound('Sem foto');
  const ext = path.extname(arquivo).toLowerCase();
  res.setHeader('Content-Type', ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
  res.setHeader('Content-Length', String(info.size));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  createReadStream(arquivo).pipe(res);
});

colaboradoresRouter.get('/:id/movimentacoes', validate({ params: idParams }), async (req, res) => {
  const id = req.valid.params.id as string;
  const alcance = await alcanceDe(req);
  if (!podeVer(alcance, id)) throw Errors.notFound('Colaborador não encontrado');
  if (!visaoDe(alcance, id).salario) throw Errors.forbidden();
  const movs = await prisma.rhMovimentacao.findMany({ where: { colaboradorId: id }, orderBy: [{ data: 'desc' }, { criadoEm: 'desc' }] });
  await audit(req, 'rh.salario_consultado', 'rh_colaborador', id, { historico: true });
  ok(res, movs);
});

// Salário, cargo, promoção, cadastro e desligamento NÃO se alteram aqui: a origem de verdade é o sistema do RH (Alexandre) e esta API só
// espelha e monitora (ver rh.sync.ts). Por isso não há rotas de escrita de colaborador nem de movimentação salarial.
