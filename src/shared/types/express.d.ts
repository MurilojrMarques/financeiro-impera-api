import type { PerfilUsuario } from '../../generated/prisma/client';

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      email: string;
      perfil: PerfilUsuario;
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
