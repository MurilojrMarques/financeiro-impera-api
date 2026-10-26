import type { PerfilUsuario, RhPapel } from '../../generated/prisma/client';

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      email: string | null;
      perfil: PerfilUsuario;
      /** papel no RH (null = sem acesso ao RH) e o colaborador deste login; sempre lidos do banco */
      rhPapel: RhPapel | null;
      colaboradorId: string | null;
      sessaoId: string;
    }
    interface Request {
      id: string;
      user?: AuthUser;
      /** Resultado já validado pelo middleware validate() */
      valid: { query?: any; body?: any; params?: any };
    }
  }
}

export {};
