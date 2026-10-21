import type { NextFunction, Request, Response } from 'express';
import type { PerfilUsuario } from '../generated/prisma/client';
import { Errors } from '../shared/errors/app-error';

/** Grupos de perfis centralizados — rotas referenciam estes grupos, não listas soltas. */
export const Roles = {
  ADMIN: ['ADMIN'],
  FINANCEIRO: ['ADMIN', 'FINANCEIRO'],
  ANALISE: ['ADMIN', 'FINANCEIRO', 'ANALISTA'],
  LEITURA: ['ADMIN', 'FINANCEIRO', 'ANALISTA', 'LEITURA'],
} as const satisfies Record<string, readonly PerfilUsuario[]>;

export function authorize(allowed: readonly PerfilUsuario[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Errors.unauthorized());
    if (!allowed.includes(req.user.perfil)) return next(Errors.forbidden());
    next();
  };
}
