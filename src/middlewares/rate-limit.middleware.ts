import { rateLimit } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { Errors } from '../shared/errors/app-error';

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req: Request, _res: Response, next: NextFunction) => next(Errors.tooMany()),
  });
}

export const globalLimiter = limiter(60_000, env.RATE_LIMIT_GLOBAL_MAX);
export const loginLimiter = limiter(env.RATE_LIMIT_LOGIN_WINDOW_SECONDS * 1000, env.RATE_LIMIT_LOGIN_MAX);
/** Refresh/troca de senha: mais restritivo que o global. */
export const sensitiveLimiter = limiter(60_000, 30);
/** Execução manual de sincronização: poucas por minuto. */
export const syncTriggerLimiter = limiter(60_000, 3);
/** "Esqueci minha senha": poucas solicitações por IP (além do limite por conta, no serviço). */
export const forgotLimiter = limiter(15 * 60_000, 5);
/** Validação/uso de links de redefinição e convite: impede adivinhação de tokens. */
export const linkLimiter = limiter(15 * 60_000, 20);
/** Ações administrativas que disparam e-mail (convite, redefinição): evita abuso por conta comprometida. */
export const emailActionLimiter = limiter(60_000, 10);
