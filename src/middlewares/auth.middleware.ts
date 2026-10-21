import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/database';
import { Errors } from '../shared/errors/app-error';
import { verifyAccessToken } from '../modules/auth/token.service';

/**
 * Exige Access Token válido (assinatura, expiração, emissor, audiência), sessão ativa e usuário ativo.
 * Contas com senha temporária só podem acessar rotas marcadas com allowPasswordChangePending.
 */
export function authenticate(opts: { allowPasswordChangePending?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw Errors.unauthorized();
      const claims = verifyAccessToken(header.slice(7));
      if (!claims) throw Errors.unauthorized();

      const sessao = await prisma.sessao.findUnique({
        where: { id: claims.sid },
        select: { revogadaEm: true, expiraEm: true, usuario: { select: { id: true, email: true, perfil: true, ativo: true, trocaSenhaObrig: true } } },
      });
      if (!sessao || sessao.revogadaEm || sessao.expiraEm < new Date()) throw Errors.unauthorized();
      const u = sessao.usuario;
      if (!u.ativo || u.id !== claims.sub) throw Errors.unauthorized();
      if (u.trocaSenhaObrig && !opts.allowPasswordChangePending) throw Errors.passwordChangeRequired();

      // perfil vem SEMPRE do banco, nunca do token/cliente
      req.user = { id: u.id, email: u.email, perfil: u.perfil, sessaoId: claims.sid };
      next();
    } catch (e) {
      next(e);
    }
  };
}
