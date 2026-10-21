import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { noContent, ok } from '../../shared/utils/response';
import { authService, type AuthResult } from './auth.service';
import { generateCsrfToken } from './token.service';

export const REFRESH_COOKIE = 'rt';
export const CSRF_COOKIE = 'csrf';
const COOKIE_PATH = '/api/v1/auth';
const CSRF_PATH = '/';

function baseCookie(): CookieOptions {
  return {
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
}

function setAuthCookies(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie(), httpOnly: true });
  // Double-submit: legível pelo JS do dashboard para ecoar no header X-CSRF-Token. Path "/" (e não o do refresh): um cookie
  // restrito a /api/v1/auth é invisível ao document.cookie de uma página em /dashboard, e o SPA nunca conseguiria renovar a sessão
  // após um F5. Não é segredo de sessão (o refresh token continua HttpOnly e restrito ao seu path).
  res.cookie(CSRF_COOKIE, generateCsrfToken(), { ...baseCookie(), path: CSRF_PATH, httpOnly: false });
}

function clearAuthCookies(res: Response): void {
  const { maxAge: _m, ...opts } = baseCookie();
  res.clearCookie(REFRESH_COOKIE, opts);
  res.clearCookie(CSRF_COOKIE, { ...opts, path: CSRF_PATH });
  res.clearCookie(CSRF_COOKIE, opts); // cookie antigo (path /api/v1/auth), de sessões emitidas antes da correção
}

const ctx = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

function respond(res: Response, r: AuthResult): void {
  setAuthCookies(res, r.refreshToken);
  ok(res, { accessToken: r.accessToken, tokenType: 'Bearer', expiresIn: r.expiresIn, usuario: r.usuario });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, senha } = req.valid.body;
  try {
    const r = await authService.login(email, senha, ctx(req));
    await audit(req, 'auth.login', 'usuario', r.usuario.id, undefined, r.usuario.id);
    respond(res, r);
  } catch (e) {
    await audit(req, 'auth.login_falha', 'usuario', undefined, { motivo: 'credenciais' });
    throw e;
  }
}

function presentedRefresh(req: Request): string {
  const token: string | undefined = req.cookies?.[REFRESH_COOKIE] ?? req.valid.body?.refreshToken;
  if (!token) throw Errors.unauthorized();
  return token;
}

export async function refresh(req: Request, res: Response): Promise<void> {
  respond(res, await authService.refresh(presentedRefresh(req), ctx(req)));
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token: string | undefined = req.cookies?.[REFRESH_COOKIE] ?? req.valid.body?.refreshToken;
  if (token) await authService.logoutByRefresh(token);
  clearAuthCookies(res);
  noContent(res);
}

export async function logoutAll(req: Request, res: Response): Promise<void> {
  const n = await authService.logoutAll(req.user!.id);
  await audit(req, 'auth.logout_all', 'usuario', req.user!.id, { sessoes: n });
  clearAuthCookies(res);
  noContent(res);
}

export async function me(req: Request, res: Response): Promise<void> {
  ok(res, await authService.me(req.user!.id));
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { senhaAtual, novaSenha } = req.valid.body;
  await authService.changePassword(req.user!.id, req.user!.sessaoId, senhaAtual, novaSenha);
  await audit(req, 'auth.troca_senha', 'usuario', req.user!.id);
  noContent(res);
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  const sessoes = await authService.listSessions(req.user!.id);
  ok(res, sessoes.map((s) => ({ ...s, atual: s.id === req.user!.sessaoId })));
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  await authService.revokeOwnSession(req.user!.id, req.valid.params.id);
  await audit(req, 'auth.sessao_revogada', 'sessao', req.valid.params.id);
  noContent(res);
}
