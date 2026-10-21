import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import type { Prisma } from '../../generated/prisma/client';
import { Errors } from '../../shared/errors/app-error';
import { currentMonthRange } from '../../shared/utils/dates';
import { resolverFiltro, type FiltroResolvido } from '../../shared/validators/filtros';
import { custosPeriodo } from '../financeiro/financeiro.service';

const ymdToDate = (s: string) => new Date(`${s}T00:00:00Z`);

const custoSelect = {
  id: true, descricao: true, tipo: true, grupo: true, valorCentavos: true, vencimento: true, statusPagamento: true,
  observacao: true, criadoEm: true, atualizadoEm: true,
  categoria: { select: { id: true, nome: true } },
  recorrencia: { select: { id: true, periodicidade: true, inicio: true, fim: true } },
  responsavel: { select: { id: true, nome: true } },
  _count: { select: { anexos: true } },
} satisfies Prisma.CustoOperacionalSelect;

/** Tipos reais aceitos em anexos (verificados pelo conteúdo, não pela extensão/Content-Type do cliente). */
const MIME_PERMITIDOS: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

export class CustosService {
  async listar(q: {
    page: number; limit: number; de?: string; ate?: string; categoriaId?: string;
    status?: 'PENDENTE' | 'PAGO' | 'CANCELADO'; grupo?: string; busca?: string; sortBy: string; sortOrder: 'ASC' | 'DESC';
  }) {
    const where: Prisma.CustoOperacionalWhereInput = {
      ...(q.de || q.ate ? { vencimento: { ...(q.de ? { gte: ymdToDate(q.de) } : {}), ...(q.ate ? { lte: ymdToDate(q.ate) } : {}) } } : {}),
      ...(q.categoriaId ? { categoriaId: q.categoriaId } : {}),
      ...(q.status ? { statusPagamento: q.status } : {}),
      ...(q.grupo ? { grupo: q.grupo as never } : {}),
      ...(q.busca ? { descricao: { contains: q.busca, mode: 'insensitive' } } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.custoOperacional.count({ where }),
      prisma.custoOperacional.findMany({
        where, select: custoSelect,
        orderBy: { [q.sortBy]: q.sortOrder.toLowerCase() as 'asc' | 'desc' },
        skip: (q.page - 1) * q.limit, take: q.limit,
      }),
    ]);
    return { total, items };
  }

  async obter(id: string) {
    const c = await prisma.custoOperacional.findUnique({ where: { id }, select: custoSelect });
    if (!c) throw Errors.notFound('Custo não encontrado');
    return c;
  }

  private async validarRefs(categoriaId?: string, recorrenciaId?: string | null): Promise<void> {
    if (categoriaId && !(await prisma.categoriaCusto.findUnique({ where: { id: categoriaId }, select: { ativa: true } }))?.ativa) {
      throw Errors.validation([{ path: 'categoriaId', message: 'categoria inexistente ou inativa' }]);
    }
    if (recorrenciaId && !(await prisma.recorrenciaCusto.findUnique({ where: { id: recorrenciaId }, select: { id: true } }))) {
      throw Errors.validation([{ path: 'recorrenciaId', message: 'recorrência inexistente' }]);
    }
  }

  async criar(userId: string, b: { descricao: string; tipo: string; categoriaId: string; recorrenciaId?: string; grupo?: string; valorCentavos: number; vencimento: string; statusPagamento: 'PENDENTE' | 'PAGO' | 'CANCELADO'; observacao?: string }) {
    await this.validarRefs(b.categoriaId, b.recorrenciaId);
    return prisma.custoOperacional.create({
      data: { ...b, grupo: b.grupo as never, vencimento: ymdToDate(b.vencimento), responsavelId: userId },
      select: custoSelect,
    });
  }

  async atualizar(id: string, b: Record<string, unknown>) {
    await this.obter(id);
    await this.validarRefs(b.categoriaId as string | undefined, b.recorrenciaId as string | null | undefined);
    const data = { ...b, ...(typeof b.vencimento === 'string' ? { vencimento: ymdToDate(b.vencimento) } : {}) };
    return prisma.custoOperacional.update({ where: { id }, data: data as Prisma.CustoOperacionalUncheckedUpdateInput, select: custoSelect });
  }

  async remover(id: string) {
    const anexos = await prisma.anexoCusto.findMany({ where: { custoId: id }, select: { caminho: true } });
    await this.obter(id);
    await prisma.custoOperacional.delete({ where: { id } });
    await Promise.all(anexos.map((a) => rm(this.caminhoAbsoluto(a.caminho), { force: true })));
  }

  async resumo(f: FiltroResolvido) {
    const c = await custosPeriodo(f, {});
    return {
      totalLancamentosCentavos: c.lancamentosCentavos,
      porCategoria: c.porCategoria,
      porGrupo: c.porGrupo,
      ocorrencias: c.ocorrencias.length,
      projetadas: c.ocorrencias.filter((o) => o.projetada).length,
      pagoCentavos: c.ocorrencias.filter((o) => o.statusPagamento === 'PAGO').reduce((s, o) => s + o.valorCentavos, 0),
      pendenteCentavos: c.ocorrencias.filter((o) => o.statusPagamento !== 'PAGO').reduce((s, o) => s + o.valorCentavos, 0),
      metodologia: c.metodologia,
    };
  }

  // ── categorias
  listarCategorias() {
    return prisma.categoriaCusto.findMany({ orderBy: { nome: 'asc' } });
  }
  async criarCategoria(nome: string) {
    if (await prisma.categoriaCusto.findUnique({ where: { nome } })) throw Errors.conflict('Categoria já existe');
    return prisma.categoriaCusto.create({ data: { nome } });
  }
  async atualizarCategoria(id: string, data: { nome?: string; ativa?: boolean }) {
    if (!(await prisma.categoriaCusto.findUnique({ where: { id } }))) throw Errors.notFound('Categoria não encontrada');
    if (data.nome) {
      const outra = await prisma.categoriaCusto.findUnique({ where: { nome: data.nome } });
      if (outra && outra.id !== id) throw Errors.conflict('Categoria já existe');
    }
    return prisma.categoriaCusto.update({ where: { id }, data });
  }

  // ── recorrências
  listarRecorrencias() {
    return prisma.recorrenciaCusto.findMany({ orderBy: { inicio: 'desc' } });
  }
  criarRecorrencia(b: { periodicidade: 'SEMANAL' | 'MENSAL' | 'TRIMESTRAL' | 'ANUAL'; inicio: string; fim?: string }) {
    return prisma.recorrenciaCusto.create({
      data: { periodicidade: b.periodicidade, inicio: ymdToDate(b.inicio), fim: b.fim ? ymdToDate(b.fim) : null },
    });
  }

  // ── anexos (armazenamento privado em disco, fora de qualquer rota estática)
  private caminhoAbsoluto(rel: string): string {
    const base = path.resolve(env.UPLOAD_DIR);
    const abs = path.resolve(base, rel);
    if (!abs.startsWith(base + path.sep)) throw Errors.badRequest('Caminho de arquivo inválido');
    return abs;
  }

  async adicionarAnexo(custoId: string, file: { buffer: Buffer; originalname: string; size: number }) {
    await this.obter(custoId);
    const { fileTypeFromBuffer } = await import('file-type');
    const tipo = await fileTypeFromBuffer(file.buffer);
    const ext = tipo ? MIME_PERMITIDOS[tipo.mime] : undefined;
    if (!tipo || !ext) throw Errors.validation([{ path: 'arquivo', message: 'Tipo de arquivo não permitido (somente PDF, PNG ou JPEG)' }]);
    const rel = path.join(custoId, `${randomUUID()}.${ext}`);
    const abs = this.caminhoAbsoluto(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.buffer, { mode: 0o600 });
    const nomeSeguro = path.basename(file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 120);
    return prisma.anexoCusto.create({
      data: { custoId, nomeOriginal: nomeSeguro, mime: tipo.mime, tamanhoBytes: file.size, caminho: rel },
      select: { id: true, nomeOriginal: true, mime: true, tamanhoBytes: true, criadoEm: true },
    });
  }

  async listarAnexos(custoId: string) {
    await this.obter(custoId);
    return prisma.anexoCusto.findMany({
      where: { custoId },
      select: { id: true, nomeOriginal: true, mime: true, tamanhoBytes: true, criadoEm: true },
      orderBy: { criadoEm: 'desc' },
    });
  }

  async lerAnexo(custoId: string, anexoId: string) {
    const a = await prisma.anexoCusto.findFirst({ where: { id: anexoId, custoId } });
    if (!a) throw Errors.notFound('Anexo não encontrado');
    return { anexo: a, conteudo: await readFile(this.caminhoAbsoluto(a.caminho)) };
  }

  async removerAnexo(custoId: string, anexoId: string) {
    const a = await prisma.anexoCusto.findFirst({ where: { id: anexoId, custoId } });
    if (!a) throw Errors.notFound('Anexo não encontrado');
    await prisma.anexoCusto.delete({ where: { id: a.id } });
    await rm(this.caminhoAbsoluto(a.caminho), { force: true });
  }

  periodoPadrao(de?: string, ate?: string): FiltroResolvido {
    const mes = currentMonthRange();
    const d = de ?? mes.de;
    const a = ate ?? mes.ate;
    return resolverFiltro({ modo: 'MOVIMENTACAO', page: 1, limit: 20, sortOrder: 'DESC', de: d, ate: a });
  }
}

export const custosService = new CustosService();
