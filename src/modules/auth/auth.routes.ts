import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { csrfForCookieAuth } from '../../middlewares/csrf.middleware';
import { loginLimiter, sensitiveLimiter } from '../../middlewares/rate-limit.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as c from './auth.controller';
import { changePasswordBody, loginBody, refreshBody, sessionIdParams } from './auth.schemas';

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
