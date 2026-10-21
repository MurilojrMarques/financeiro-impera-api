import { z } from 'zod';

export const loginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  senha: z.string().min(1).max(256),
});

export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });

export const changePasswordBody = z.object({
  senhaAtual: z.string().min(1).max(256),
  novaSenha: z.string().min(12).max(256),
});

export const sessionIdParams = z.object({ id: z.string().uuid() });
