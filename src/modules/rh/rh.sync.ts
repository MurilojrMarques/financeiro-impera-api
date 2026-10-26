import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import type { EstadoOrigem } from '../../integrations/rh-mysql/rh-mysql';
import type { Prisma, RhTipoAlteracao, RhTipoMovimentacao } from '../../generated/prisma/client';
import { sanitizeError } from '../../shared/utils/text';
import { fotosDir } from './rh.storage';

/**
 * Espelha o sistema de RH de origem (do Alexandre) nas tabelas relacionais e DETECTA mudanças entre uma leitura e a seguinte.
 * Regra de ouro: salário, cargo e promoção nascem SOMENTE na origem. Esta API nunca grava na origem e não tem rota para alterar salário,
 * então não existe "segundo salário". Cada mudança detectada vira uma linha em `rh_alteracoes` (com valores antes e depois).
 */

type Obj = Record<string, unknown>;

export interface ResultadoSync {
  lidos: number;
  novos: number;
  atualizados: number;
  alteracoes: { tipo: RhTipoAlteracao; colaboradorId: string | null; campo: string | null; anterior: string | null; novo: string | null }[];
  inconsistencias: { colaboradorId: string; salarioAtualCentavos: number; ultimoReajusteCentavos: number }[];
  avisos: string[];
  /** colaboradores cujo salário mudou (para recalcular a folha aberta) */
  salarioMudou: string[];
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const centavos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);

/** Aceita AAAA-MM-DD (com ou sem hora) e DD/MM/AAAA. */
export function lerData(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  let m: string[] | null = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    m = br ? [br[0], br[3]!, br[2]!, br[1]!] : null;
  }
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

async function salvarFoto(id: string, base64: string | null, aplicar: boolean, avisos: string[]): Promise<string | null> {
  if (!base64) return null;
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(base64);
  if (!m) {
    avisos.push('foto em formato não reconhecido (ignorada)');
    return null;
  }
  const buf = Buffer.from(m[2]!, 'base64');
  if (buf.length === 0 || buf.length > 2_000_000) {
    avisos.push('foto vazia ou grande demais (ignorada)');
    return null;
  }
  const nome = `${id}.${m[1]!.toLowerCase().replace('jpeg', 'jpg')}`;
  if (aplicar) {
    await mkdir(fotosDir(), { recursive: true });
    await writeFile(path.join(fotosDir(), nome), buf);
  }
  return nome;
}

/**
 * Lê `origem`, compara com o que já está no banco e (se `aplicar`) grava. Sem `aplicar` é uma simulação: devolve o que mudaria.
 * Não cria a linha de `rh_sincronizacoes`: quem chama (job/rota/script) registra o resultado.
 */
export async function sincronizarRh(origem: EstadoOrigem, opts: { aplicar: boolean }): Promise<ResultadoSync> {
  const aplicar = opts.aplicar;
  const colabs = (origem.estado.colaboradores ?? []) as Obj[];
  const promos = (origem.estado.promocoes ?? []) as Obj[];
  const faixas = (origem.estado.faixasSalariais ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const r: ResultadoSync = { lidos: colabs.length, novos: 0, atualizados: 0, alteracoes: [], inconsistencias: [], avisos: [], salarioMudou: [] };
  const alt = (tipo: RhTipoAlteracao, colaboradorId: string | null, campo: string | null, anterior: string | null, novo: string | null): void => {
    r.alteracoes.push({ tipo, colaboradorId, campo, anterior, novo });
  };

  const existentes = await prisma.rhColaborador.findMany();
  const porLegado = new Map(existentes.filter((c) => c.legadoId).map((c) => [c.legadoId!, c]));
  const idPorLegado = new Map<string, string>();
  const vistos = new Set<string>();

  // 1) colaboradores
  const paraGravar: { id: string; legadoId: string; dados: Prisma.RhColaboradorUncheckedCreateInput }[] = [];
  for (const [i, c] of colabs.entries()) {
    const legadoId = str(c.id);
    const nome = str(c.nome);
    const salario = centavos(c.salario);
    if (!legadoId || !nome || salario === null) {
      r.avisos.push(`colaborador #${i + 1} ignorado (sem id, nome ou salário)`);
      continue;
    }
    vistos.add(legadoId);
    const atual = porLegado.get(legadoId);
    const id = atual?.id ?? crypto.randomUUID();
    idPorLegado.set(legadoId, id);
    const foto = str(c.foto);
    const fotoHash = foto ? createHash('sha256').update(foto).digest('hex') : null;
    const fotoMudou = fotoHash !== (atual?.fotoHash ?? null);
    const dados: Prisma.RhColaboradorUncheckedCreateInput = {
      id,
      legadoId,
      nome,
      email: str(c.email)?.toLowerCase() ?? null,
      celular: str(c.celular),
      nascimento: lerData(c.nascimento),
      cnpj: str(c.cnpj),
      endereco: str(c.endereco),
      camiseta: str(c.camiseta),
      departamento: str(c.departamento) ?? 'Sem departamento',
      cargoBase: str(c.cargoBase),
      funcao: str(c.funcao),
      tipoCargo: str(c.tipoCargo),
      senioridade: str(c.senioridade),
      subnivel: int(c.subnivel),
      inicio: lerData(c.inicio),
      demissao: lerData(c.demissao),
      motivoDemissao: str(c.motivoDemissao),
      contratoObs: str(c.contrato),
      salarioCentavos: salario,
      descricao: str(c.descricao),
      obsCargo: str(c.obsCargo),
      discordUserId: str(c.discordUserId),
      fotoArquivo: fotoMudou ? await salvarFoto(id, foto, aplicar, r.avisos) : (atual?.fotoArquivo ?? null),
      fotoHash: fotoMudou ? fotoHash : (atual?.fotoHash ?? null),
    };

    if (!atual) {
      r.novos++;
      alt('NOVO_COLABORADOR', id, null, null, nome);
    } else {
      let mudou = false;
      const campos: [keyof typeof dados, string][] = [['nome', 'nome'], ['email', 'email'], ['celular', 'celular'], ['cnpj', 'cnpj'], ['endereco', 'endereco'], ['camiseta', 'camiseta'], ['tipoCargo', 'tipoCargo'], ['contratoObs', 'contratoObs'], ['descricao', 'descricao'], ['obsCargo', 'obsCargo'], ['discordUserId', 'discordUserId'], ['inicio', 'inicio'], ['nascimento', 'nascimento'], ['motivoDemissao', 'motivoDemissao']];
      for (const [k] of campos) {
        const a = (atual as unknown as Obj)[k];
        const b = (dados as unknown as Obj)[k];
        const ax = a instanceof Date ? a.toISOString() : a ?? null;
        const bx = b instanceof Date ? b.toISOString() : b ?? null;
        if (ax !== bx) mudou = true;
      }
      if (atual.salarioCentavos !== salario) {
        mudou = true;
        alt('SALARIO', id, 'salario', String(atual.salarioCentavos), String(salario));
        r.salarioMudou.push(id);
      }
      for (const [campo, tipo] of [['funcao', 'CARGO'], ['cargoBase', 'CARGO'], ['senioridade', 'CARGO'], ['subnivel', 'CARGO'], ['departamento', 'DEPARTAMENTO']] as const) {
        const a = atual[campo] ?? null;
        const b = dados[campo] ?? null;
        if (a !== b) {
          mudou = true;
          alt(tipo, id, campo, a === null ? null : String(a), b === null ? null : String(b));
        }
      }
      if (iso(atual.demissao) !== iso(dados.demissao as Date | null)) {
        mudou = true;
        alt('DESLIGAMENTO', id, 'demissao', iso(atual.demissao), iso(dados.demissao as Date | null));
      }
      if (fotoMudou) mudou = true;
      if (mudou) r.atualizados++;
      else continue; // nada mudou: não regrava
    }
    paraGravar.push({ id, legadoId, dados });
  }

  // quem sumiu da origem: nunca apagamos (histórico de folha), só avisamos uma vez
  for (const c of existentes) {
    if (c.legadoId && !vistos.has(c.legadoId)) {
      const jaAvisado = await prisma.rhAlteracao.findFirst({ where: { colaboradorId: c.id, tipo: 'REMOVIDO_DA_ORIGEM' }, select: { id: true } });
      if (!jaAvisado) alt('REMOVIDO_DA_ORIGEM', c.id, null, c.nome, null);
    }
  }

  // gestor: é a relação entre pessoas; o vínculo é gravado no passo 4
  const gestorPorLegado = new Map(colabs.map((c) => [str(c.id), str(c.gestorId)] as const));
  for (const c of existentes) {
    if (!c.legadoId || !vistos.has(c.legadoId)) continue;
    const novoGestorLegado = gestorPorLegado.get(c.legadoId) ?? null;
    const novoGestorId = novoGestorLegado ? (idPorLegado.get(novoGestorLegado) ?? null) : null;
    if ((c.gestorId ?? null) !== novoGestorId) {
      alt('GESTOR', c.id, 'gestorId', c.gestorId, novoGestorId);
      if (!paraGravar.some((p) => p.id === c.id)) r.atualizados++;
    }
  }

  // 2) promoções e reajustes (histórico)
  const movsExistentes = new Map((await prisma.rhMovimentacao.findMany()).map((m) => [m.legadoId!, m]));
  const movsParaGravar: Prisma.RhMovimentacaoUncheckedCreateInput[] = [];
  const ultimaPorColab = new Map<string, { data: Date; novo: number }>();
  for (const [i, p] of promos.entries()) {
    const legadoId = str(p.id);
    const colaboradorLegado = str(p.colaboradorId);
    const colaboradorId = colaboradorLegado ? idPorLegado.get(colaboradorLegado) : undefined;
    const d = lerData(p.data);
    const anterior = centavos(p.salarioAnterior);
    const novo = centavos(p.salarioNovo);
    if (!legadoId || !colaboradorId || !d || anterior === null || novo === null) {
      r.avisos.push(`movimentação #${i + 1} ignorada (sem id, colaborador, data ou salários)`);
      continue;
    }
    const tipoBruto = str(p.tipo);
    const tipo: RhTipoMovimentacao = tipoBruto === 'promocao' ? 'PROMOCAO' : tipoBruto === 'reajuste' ? 'REAJUSTE' : str(p.cargoNovo) !== str(p.cargoAnterior) ? 'PROMOCAO' : 'REAJUSTE';
    const dados: Prisma.RhMovimentacaoUncheckedCreateInput = {
      legadoId,
      colaboradorId,
      tipo,
      data: d,
      cargoAnterior: str(p.cargoAnterior),
      cargoNovo: str(p.cargoNovo),
      departamentoAnterior: str(p.departamentoAnterior),
      departamentoNovo: str(p.departamentoNovo),
      senioridadeAnterior: str(p.senioridadeAnterior),
      senioridadeNova: str(p.senioridadeNova),
      subnivelAnterior: int(p.subnivelAnterior),
      subnivelNovo: int(p.subnivelNovo),
      salarioAnteriorCentavos: anterior,
      salarioNovoCentavos: novo,
      obs: str(p.obs),
    };
    const ult = ultimaPorColab.get(colaboradorId);
    if (!ult || d.getTime() >= ult.data.getTime()) ultimaPorColab.set(colaboradorId, { data: d, novo });
    const atual = movsExistentes.get(legadoId);
    if (!atual) {
      alt('MOVIMENTACAO', colaboradorId, tipo, String(anterior), String(novo));
      movsParaGravar.push(dados);
    } else if (atual.salarioNovoCentavos !== novo || atual.salarioAnteriorCentavos !== anterior || atual.data.getTime() !== d.getTime() || atual.cargoNovo !== dados.cargoNovo) {
      alt('MOVIMENTACAO', colaboradorId, `${tipo} (corrigido na origem)`, String(atual.salarioNovoCentavos), String(novo));
      movsParaGravar.push(dados);
    }
  }

  // 3) conferência na origem: o salário atual de cada pessoa deve ser o do último reajuste registrado
  for (const c of colabs) {
    const id = idPorLegado.get(str(c.id) ?? '');
    const ult = id ? ultimaPorColab.get(id) : undefined;
    const atual = centavos(c.salario);
    if (id && ult && atual !== null && ult.novo !== atual) r.inconsistencias.push({ colaboradorId: id, salarioAtualCentavos: atual, ultimoReajusteCentavos: ult.novo });
  }

  if (!aplicar) return r;

  // 4) grava (colaboradores primeiro, depois o vínculo com o gestor)
  for (const g of paraGravar) {
    const { id, legadoId, ...resto } = g.dados;
    await prisma.rhColaborador.upsert({ where: { legadoId: g.legadoId }, create: { id, legadoId, ...resto }, update: resto });
  }
  for (const c of colabs) {
    const legadoId = str(c.id);
    if (!legadoId || !idPorLegado.has(legadoId)) continue;
    const gestorLegado = str(c.gestorId);
    const gestorId = gestorLegado ? (idPorLegado.get(gestorLegado) ?? null) : null;
    if (gestorLegado && !gestorId) r.avisos.push('gestor referenciado não existe na lista de colaboradores');
    // (em SQL, NULL <> 'x' não é verdadeiro: o caso "ainda sem gestor" precisa ser tratado à parte)
    await prisma.rhColaborador.updateMany({ where: { legadoId, ...(gestorId ? { OR: [{ gestorId: null }, { gestorId: { not: gestorId } }] } : { gestorId: { not: null } }) }, data: { gestorId } });
  }
  for (const m of movsParaGravar) {
    const { legadoId, ...resto } = m;
    await prisma.rhMovimentacao.upsert({ where: { legadoId: legadoId! }, create: m, update: resto });
  }

  // 5) matriz de cargos e salários
  for (const [departamento, cargos] of Object.entries(faixas)) {
    for (const [cargo, niveis] of Object.entries(cargos ?? {})) {
      for (const [nivel, valor] of Object.entries(niveis ?? {})) {
        const v = centavos(valor);
        if (v === null) continue;
        await prisma.rhFaixaSalarial.upsert({ where: { departamento_cargo_nivel: { departamento, cargo, nivel } }, create: { departamento, cargo, nivel, valorCentavos: v }, update: { valorCentavos: v } });
      }
    }
  }

  // 6) usuários do sistema de origem (sem senha): só o vínculo papel × colaborador
  for (const a of origem.admins) {
    const colab = a.colaborador_id ? idPorLegado.get(String(a.colaborador_id)) : undefined;
    const dados = { username: String(a.username), email: a.email ? String(a.email).toLowerCase() : null, papel: String(a.role), departamento: a.departamento ? String(a.departamento) : null, colaboradorId: colab ?? null };
    await prisma.rhUsuarioLegado.upsert({ where: { legadoId: Number(a.id) }, create: { legadoId: Number(a.id), ...dados }, update: dados });
  }

  // 7) quem foi desligado na origem perde o acesso aqui
  for (const a of r.alteracoes.filter((x) => x.tipo === 'DESLIGAMENTO' && x.novo && x.colaboradorId)) {
    const u = await prisma.usuario.findUnique({ where: { colaboradorId: a.colaboradorId! }, select: { id: true, ativo: true } });
    if (u?.ativo) {
      await prisma.usuario.update({ where: { id: u.id }, data: { ativo: false } });
      await prisma.sessao.updateMany({ where: { usuarioId: u.id, revogadaEm: null }, data: { revogadaEm: new Date() } });
    }
  }
  return r;
}

/** Registra uma execução (com as mudanças detectadas) e devolve o id. Nunca guarda valores de salário em log: só na tabela de alterações. */
export async function registrarSincronizacao(
  gatilho: string,
  origem: { atualizadoEm: Date | null; atualizadoPor: string | null },
  r: ResultadoSync | null,
  erro: unknown,
): Promise<string> {
  const s = await prisma.rhSincronizacao.create({
    data: {
      status: erro ? 'ERRO' : 'SUCESSO',
      gatilho,
      concluidaEm: new Date(),
      origemAtualizadaEm: origem.atualizadoEm,
      origemAtualizadaPor: origem.atualizadoPor,
      lidos: r?.lidos ?? 0,
      novos: r?.novos ?? 0,
      atualizados: r?.atualizados ?? 0,
      alteracoes: r?.alteracoes.length ?? 0,
      inconsistencias: r?.inconsistencias.length ?? 0,
      erro: erro ? sanitizeError(erro).slice(0, 500) : null,
      detalhes: r ? ({ avisos: r.avisos.slice(0, 50), inconsistencias: r.inconsistencias } as Prisma.InputJsonValue) : undefined,
      alteracoesDetectadas: r ? { create: r.alteracoes.map((a) => ({ colaboradorId: a.colaboradorId, tipo: a.tipo, campo: a.campo, anterior: a.anterior, novo: a.novo })) } : undefined,
    },
  });
  if (r && r.alteracoes.length > 0) {
    const porTipo: Record<string, number> = {};
    for (const a of r.alteracoes) porTipo[a.tipo] = (porTipo[a.tipo] ?? 0) + 1;
    logger.warn({ sincronizacaoId: s.id, porTipo }, 'alterações detectadas no sistema de RH de origem');
  }
  return s.id;
}
