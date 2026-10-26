import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { prisma } from '../../config/database';
import { Prisma } from '../../generated/prisma/client';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { created, noContent, ok, pageMeta, paginated } from '../../shared/utils/response';
import { alcanceDe, escreve, exigeRh, PAPEIS_ESCREVEM, PAPEIS_VEEM_SALARIO, podeVer, serializarColaborador, visaoDe } from './rh.access';
import { atualizarColaboradorBody, criarColaboradorBody, idParams, listQuery, movimentacaoBody } from './rh.schemas';
import { fotosDir } from './rh.storage';

export const colaboradoresRouter = Router();

const dia = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
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

// ── escrita: somente RH ──────────────────────────────────────────────────────────────────────────────────────────────────────

colaboradoresRouter.post('/', exigeRh(PAPEIS_ESCREVEM), validate({ body: criarColaboradorBody }), async (req, res) => {
  const b = req.valid.body as ReturnType<typeof criarColaboradorBody.parse>;
  if (b.gestorId && !(await prisma.rhColaborador.findUnique({ where: { id: b.gestorId }, select: { id: true } }))) throw Errors.validation([{ path: 'gestorId', message: 'Gestor não encontrado' }]);
  const c = await prisma.rhColaborador.create({
    data: { ...b, nascimento: b.nascimento ? dia(b.nascimento) : null, inicio: b.inicio ? dia(b.inicio) : null },
    include: comGestor,
  });
  await audit(req, 'rh.colaborador_criado', 'rh_colaborador', c.id, { departamento: c.departamento, salarioCentavos: c.salarioCentavos });
  created(res, serializarColaborador(c, { salario: true, pessoais: true }));
});

colaboradoresRouter.patch('/:id', exigeRh(PAPEIS_ESCREVEM), validate({ params: idParams, body: atualizarColaboradorBody }), async (req, res) => {
  const id = req.valid.params.id as string;
  const b = req.valid.body as ReturnType<typeof atualizarColaboradorBody.parse>;
  if (!(await prisma.rhColaborador.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound('Colaborador não encontrado');
  if (b.gestorId === id) throw Errors.validation([{ path: 'gestorId', message: 'O colaborador não pode ser o próprio gestor' }]);
  if (b.gestorId && !(await prisma.rhColaborador.findUnique({ where: { id: b.gestorId }, select: { id: true } }))) throw Errors.validation([{ path: 'gestorId', message: 'Gestor não encontrado' }]);
  const { nascimento, inicio, demissao, ...resto } = b;
  const c = await prisma.rhColaborador.update({
    where: { id },
    data: {
      ...resto,
      ...(nascimento !== undefined ? { nascimento: nascimento ? dia(nascimento) : null } : {}),
      ...(inicio !== undefined ? { inicio: inicio ? dia(inicio) : null } : {}),
      ...(demissao !== undefined ? { demissao: demissao ? dia(demissao) : null } : {}),
    },
    include: comGestor,
  });
  if (demissao) {
    // quem saiu perde o acesso ao sistema
    const u = await prisma.usuario.findUnique({ where: { colaboradorId: id }, select: { id: true } });
    if (u) {
      await prisma.usuario.update({ where: { id: u.id }, data: { ativo: false } });
      await prisma.sessao.updateMany({ where: { usuarioId: u.id, revogadaEm: null }, data: { revogadaEm: new Date() } });
    }
  }
  await audit(req, 'rh.colaborador_atualizado', 'rh_colaborador', id, { campos: Object.keys(b) });
  ok(res, serializarColaborador(c, { salario: true, pessoais: true }));
});

/** Promoção ou reajuste: grava o histórico e atualiza o salário (e cargo, se informado) do colaborador, numa transação. */
colaboradoresRouter.post('/:id/movimentacoes', exigeRh(PAPEIS_ESCREVEM), validate({ params: idParams, body: movimentacaoBody }), async (req, res) => {
  const id = req.valid.params.id as string;
  const b = req.valid.body as ReturnType<typeof movimentacaoBody.parse>;
  const mov = await prisma.$transaction(async (tx) => {
    const c = await tx.rhColaborador.findUnique({ where: { id } });
    if (!c) throw Errors.notFound('Colaborador não encontrado');
    if (c.demissao) throw Errors.conflict('Colaborador desligado: não é possível registrar reajuste');
    if (b.tipo === 'REAJUSTE' && b.salarioNovoCentavos === c.salarioCentavos) throw Errors.validation([{ path: 'salarioNovoCentavos', message: 'O salário novo é igual ao atual' }]);
    const criada = await tx.rhMovimentacao.create({
      data: {
        colaboradorId: id,
        tipo: b.tipo,
        data: dia(b.data),
        cargoAnterior: c.funcao ?? c.cargoBase,
        cargoNovo: b.cargoNovo ?? null,
        departamentoAnterior: c.departamento,
        departamentoNovo: b.departamentoNovo ?? null,
        senioridadeAnterior: c.senioridade,
        senioridadeNova: b.senioridadeNova ?? null,
        subnivelAnterior: c.subnivel,
        subnivelNovo: b.subnivelNovo ?? null,
        salarioAnteriorCentavos: c.salarioCentavos,
        salarioNovoCentavos: b.salarioNovoCentavos,
        obs: b.obs ?? null,
      },
    });
    await tx.rhColaborador.update({
      where: { id },
      data: {
        salarioCentavos: b.salarioNovoCentavos,
        ...(b.cargoNovo ? { funcao: b.cargoNovo } : {}),
        ...(b.departamentoNovo ? { departamento: b.departamentoNovo } : {}),
        ...(b.senioridadeNova ? { senioridade: b.senioridadeNova } : {}),
        ...(b.subnivelNovo ? { subnivel: b.subnivelNovo } : {}),
      },
    });
    return criada;
  });
  await audit(req, 'rh.salario_alterado', 'rh_colaborador', id, { tipo: b.tipo, de: mov.salarioAnteriorCentavos, para: mov.salarioNovoCentavos, data: b.data });
  created(res, mov);
});

colaboradoresRouter.delete('/:id', exigeRh(PAPEIS_ESCREVEM), validate({ params: idParams }), async (req, res) => {
  // não se apaga pessoa com histórico de folha: desligue (PATCH demissao). Aqui só cadastros criados por engano, sem nada ligado.
  const id = req.valid.params.id as string;
  const c = await prisma.rhColaborador.findUnique({ where: { id }, include: { _count: { select: { rhFolhaItems: true, rhDocumentos: true, movimentacoes: true } } } });
  if (!c) throw Errors.notFound('Colaborador não encontrado');
  if (c._count.rhFolhaItems + c._count.rhDocumentos + c._count.movimentacoes > 0) throw Errors.conflict('Colaborador com histórico: registre o desligamento em vez de excluir');
  await prisma.rhColaborador.delete({ where: { id } });
  await audit(req, 'rh.colaborador_excluido', 'rh_colaborador', id);
  noContent(res);
});

void escreve;
