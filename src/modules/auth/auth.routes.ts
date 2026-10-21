import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { csrfForCookieAuth } from '../../middlewares/csrf.middleware';
import { forgotLimiter, linkLimiter, loginLimiter, sensitiveLimiter } from '../../middlewares/rate-limit.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as c from './auth.controller';
import { changePasswordBody, forgotPasswordBody, loginBody, refreshBody, resetPasswordBody, sessionIdParams, tokenBody } from './auth.schemas';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validate({ body: loginBody }), c.login);
authRouter.post('/refresh', sensitiveLimiter, validate({ body: refreshBody }), csrfForCookieAuth, c.refresh);
authRouter.post('/logout', validate({ body: refreshBody }), csrfForCookieAuth, c.logout);

const pending = authenticate({ allowPasswordChangePending: true });
authRouter.post('/logout-all', pending, c.logoutAll);
authRouter.get('/me', pending, c.me);
authRouter.patch('/change-password', sensitiveLimiter, pending, validate({ body: changePasswordBody }), c.changePassword);
authRouter.get('/sessions', pending, c.listSessions);
authRouter.delete('/sessions/:id', pending, validate({ params: sessionIdParams }), c.revokeSession);

// Fluxos públicos de conta (sem sessão): recuperação de senha e ativação de convite. Corpo JSON, sem cookies => sem CSRF.
authRouter.get('/config', c.config);
authRouter.post('/forgot-password', forgotLimiter, validate({ body: forgotPasswordBody }), c.forgotPassword);
authRouter.post('/link/validar', linkLimiter, validate({ body: tokenBody }), c.validarLink);
authRouter.post('/reset-password', linkLimiter, validate({ body: resetPasswordBody }), c.resetPassword);
authRouter.post('/activate', linkLimiter, validate({ body: resetPasswordBody }), c.activateAccount);
