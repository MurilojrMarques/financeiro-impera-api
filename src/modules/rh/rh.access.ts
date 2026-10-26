import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../config/database';
import type { RhColaborador, RhPapel } from '../../generated/prisma/client';
import { Errors } from '../../shared/errors/app-error';

/**
 * Regras de visibilidade do RH (decididas em 26/10/2026):
 *  - RH e CEO: veem todos, com salário. Só o RH altera.
 *  - GESTOR: vê a própria equipe (diretos e indiretos) SEM salário e sem dados pessoais sensíveis; vê o próprio cadastro completo.
 *  - COLABORADOR: vê só o próprio cadastro (com o próprio salário) e envia a própria NF.
 * O papel vem SEMPRE do banco (req.user), nunca do cliente. ADMIN/FINANCEIRO do sistema financeiro NÃO enxergam RH sem um papel de RH.
 */
/**
 * Papel de RH efetivo. O ADMIN do sistema enxerga TUDO do RH (como o CEO: todos os colaboradores, salários, folha, documentos e
 * monitoramento) mas NÃO escreve nada além da própria nota fiscal: só o papel RH altera folha e revisa documentos. Se o ADMIN já for RH
 * mantém RH; qualquer outro papel (ou nenhum) vira CEO (somente leitura). Sempre calculado a partir do banco, nunca do cliente.
 */
export function papelRhEfetivo(perfil: string | null | undefined, papel: RhPapel | null | undefined): RhPapel | null {
  if (perfil === 'ADMIN') return papel === 'RH' ? 'RH' : 'CEO';
  return papel ?? null;
}

export const exigeRh = (permitidos?: readonly RhPapel[]) => (req: Request, _res: Response, next: NextFunction): void => {
  const papel = req.user?.rhPapel;
  if (!papel) return next(Errors.forbidden());
  if (permitidos && !permitidos.includes(papel)) return next(Errors.forbidden());
  next();
};

export const PAPEIS_VEEM_SALARIO = ['RH', 'CEO'] as const satisfies readonly RhPapel[];
export const PAPEIS_ESCREVEM = ['RH'] as const satisfies readonly RhPapel[];

export const veTodos = (papel: RhPapel | null | undefined): boolean => papel === 'RH' || papel === 'CEO';
export const escreve = (papel: RhPapel | null | undefined): boolean => papel === 'RH';

/** Ids da equipe de um gestor: diretos e indiretos (subordinados dos subordinados). */
export async function idsDaEquipe(gestorColaboradorId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE equipe AS (
      SELECT id FROM rh_colaboradores WHERE "gestorId" = ${gestorColaboradorId}::uuid
      UNION
      SELECT c.id FROM rh_colaboradores c JOIN equipe e ON c."gestorId" = e.id
    ) SELECT id::text FROM equipe`;
  return rows.map((r) => r.id);
}

export type Alcance =
  | { tipo: 'TODOS' }
  | { tipo: 'EQUIPE'; ids: string[]; proprio: string }
  | { tipo: 'PROPRIO'; proprio: string };

/** Quais colaboradores o usuário logado pode enxergar. */
export async function alcanceDe(req: Request): Promise<Alcance> {
  const papel = req.user?.rhPapel;
  if (veTodos(papel)) return { tipo: 'TODOS' };
  const proprio = req.user?.colaboradorId;
  if (!papel || !proprio) throw Errors.forbidden();
  if (papel === 'GESTOR') return { tipo: 'EQUIPE', ids: await idsDaEquipe(proprio), proprio };
  return { tipo: 'PROPRIO', proprio };
}

export const podeVer = (a: Alcance, colaboradorId: string): boolean =>
  a.tipo === 'TODOS' || colaboradorId === a.proprio || (a.tipo === 'EQUIPE' && a.ids.includes(colaboradorId));

export interface Visao {
  /** salário e histórico salarial */
  salario: boolean;
  /** CNPJ, endereço e nascimento */
  pessoais: boolean;
}

/** O que o usuário pode ver de UM colaborador. */
export function visaoDe(a: Alcance, colaboradorId: string): Visao {
  if (a.tipo === 'TODOS') return { salario: true, pessoais: true };
  const proprio = colaboradorId === a.proprio;
  return { salario: proprio, pessoais: proprio };
}

type Colab = RhColaborador;

const centavosParaReais = (c: number): number => c / 100;
void centavosParaReais;

export function serializarColaborador(c: Colab & { gestor?: { id: string; nome: string } | null }, v: Visao) {
  return {
    id: c.id,
    nome: c.nome,
    email: c.email,
    celular: c.celular,
    camiseta: c.camiseta,
    departamento: c.departamento,
    cargoBase: c.cargoBase,
    funcao: c.funcao,
    tipoCargo: c.tipoCargo,
    senioridade: c.senioridade,
    subnivel: c.subnivel,
    gestor: c.gestor ?? null,
    gestorId: c.gestorId,
    inicio: c.inicio,
    demissao: c.demissao,
    ativo: c.demissao === null,
    foto: c.fotoArquivo ? `/api/v1/rh/colaboradores/${c.id}/foto` : null,
    ...(v.pessoais ? { nascimento: c.nascimento, cnpj: c.cnpj, endereco: c.endereco, motivoDemissao: c.motivoDemissao, discordUserId: c.discordUserId, contratoObs: c.contratoObs } : {}),
    ...(v.salario ? { salarioCentavos: c.salarioCentavos } : {}),
  };
}
