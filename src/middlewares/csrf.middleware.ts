import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../modules/auth/auth.controller';
import { Errors } from '../shared/errors/app-error';

/**
 * Double-submit cookie: só se aplica quando o refresh token chega por cookie.
 * Clientes que enviam o token no corpo (sem cookie) não são vulneráveis a CSRF.
 */
export function csrfForCookieAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.cookies?.[REFRESH_COOKIE]) return next();
  const cookie: string | undefined = req.cookies[CSRF_COOKIE];
  const header = req.headers['x-csrf-token'];
  if (!cookie || typeof header !== 'string') return next(Errors.forbidden('Token CSRF ausente'));
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return next(Errors.forbidden('Token CSRF inválido'));
  next();
}
