import type { NextFunction, Request, Response } from 'express';
import { MemoryStore, ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../config/env';
import { verifyAccessToken } from '../modules/auth/token.service';
import { Errors } from '../shared/errors/app-error';

/**
 * Atrás da Vercel/Funnel o IP que a API enxerga é o do proxy (poucos endereços compartilhados por TODOS os usuários). Por isso os
 * limites NÃO podem depender só do IP: chaves por usuário autenticado (rotas de dados) e por e-mail (login, recuperação de senha),
 * com um limite de IP mais folgado só como teto contra varredura.
 */
const stores: MemoryStore[] = [];

type Chave = (req: Request) => string;

const ip: Chave = (req) => ipKeyGenerator(req.ip ?? '');

/** Usuário do Access Token (sem consultar o banco; a validade completa é verificada depois, em `authenticate`). */
const usuarioOuIp: Chave = (req) => {
  const h = req.headers.authorization;
  const claims = h?.startsWith('Bearer ') ? verifyAccessToken(h.slice(7)) : null;
  return claims ? `u:${claims.sub}` : `ip:${ip(req)}`;
};

const emailDoCorpo = (req: Request): string | null => {
  const b = req.body as { login?: unknown; email?: unknown } | undefined;
  const e = b?.login ?? b?.email;
  return typeof e === 'string' && e.length > 0 && e.length <= 254 ? e.trim().toLowerCase() : null;
};

const porEmail = (prefixo: string): Chave => (req) => {
  const e = emailDoCorpo(req);
  return e ? `${prefixo}:${e}` : `${prefixo}-ip:${ip(req)}`;
};

function limiter(windowMs: number, limit: number, opts: { chave?: Chave; ignorarSucessos?: boolean } = {}) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs,
    limit,
    store,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: opts.ignorarSucessos ?? false,
    keyGenerator: (req: Request) => (opts.chave ?? ip)(req),
    handler: (_req: Request, _res: Response, next: NextFunction) => next(Errors.tooMany()),
  });
}

const JANELA_LOGIN = env.RATE_LIMIT_LOGIN_WINDOW_SECONDS * 1000;

/** Rotas de dados: por usuário (cada pessoa tem o seu orçamento, mesmo atrás do mesmo proxy). */
export const globalLimiter = limiter(60_000, env.RATE_LIMIT_GLOBAL_MAX, { chave: usuarioOuIp });
/** Login: tentativas FALHAS por e-mail (acertos não contam) + teto por IP contra varredura de várias contas. */
export const loginLimiter = limiter(JANELA_LOGIN, env.RATE_LIMIT_LOGIN_MAX, { chave: porEmail('login'), ignorarSucessos: true });
export const loginIpLimiter = limiter(JANELA_LOGIN, env.RATE_LIMIT_LOGIN_IP_MAX, { ignorarSucessos: true });
/** Refresh/troca de senha: mais restritivo que o global. */
export const sensitiveLimiter = limiter(60_000, 30, { chave: usuarioOuIp });
/** Execução manual de sincronização: poucas por minuto, por usuário. */
export const syncTriggerLimiter = limiter(60_000, 3, { chave: usuarioOuIp });
/** "Esqueci minha senha": poucas solicitações por e-mail (além do limite por conta, no serviço) e um teto por IP. */
export const forgotLimiter = limiter(15 * 60_000, 5, { chave: porEmail('forgot') });
export const forgotIpLimiter = limiter(15 * 60_000, 100);
/** Validação/uso de links de redefinição e convite (token de 256 bits: o limite é só contra abuso). */
export const linkLimiter = limiter(15 * 60_000, 100);
/** Ações administrativas que disparam e-mail (convite, redefinição): por administrador. */
export const emailActionLimiter = limiter(60_000, 10, { chave: usuarioOuIp });

/** Zera todos os contadores (somente testes). */
export function resetarLimitadores(): void {
  for (const s of stores) s.resetAll();
}
