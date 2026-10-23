import { z } from 'zod';

/** Nome de usuário: minúsculas, 3–32 caracteres, começa com letra/número; sem @ (para nunca ser confundido com e-mail). */
export const usuarioLogin = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'Use 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado');

/** Entra com e-mail OU usuário (`login`); `email` continua aceito por compatibilidade. */
export const loginBody = z
  .object({
    login: z.string().trim().toLowerCase().min(1).max(254).optional(),
    email: z.string().trim().toLowerCase().min(1).max(254).optional(),
    senha: z.string().min(1).max(256),
  })
  .refine((v) => !!(v.login ?? v.email), { message: 'Informe o e-mail ou o usuário', path: ['login'] })
  .transform((v) => ({ login: (v.login ?? v.email) as string, senha: v.senha }));

export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });

export const changePasswordBody = z.object({
  senhaAtual: z.string().min(1).max(256),
  novaSenha: z.string().min(12).max(256),
});

export const sessionIdParams = z.object({ id: z.string().uuid() });

export const forgotPasswordBody = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const tokenBody = z.object({ token: z.string().trim().min(20).max(200) });
export const resetPasswordBody = z.object({ token: z.string().trim().min(20).max(200), novaSenha: z.string().min(12).max(256) });
