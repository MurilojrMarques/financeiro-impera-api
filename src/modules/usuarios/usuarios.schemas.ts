import { z } from 'zod';
import { usuarioLogin } from '../auth/auth.schemas';

/** SEM_FINANCEIRO = colaborador: só o módulo de RH (nenhuma tela do financeiro) */
const perfil = z.enum(['ADMIN', 'FINANCEIRO', 'ANALISTA', 'LEITURA', 'SEM_FINANCEIRO']);

export const idParams = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  busca: z.string().trim().max(100).optional(),
  perfil: perfil.optional(),
  ativo: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const emailOpc = z.string().trim().toLowerCase().email().max(254);

/** Informe e-mail, usuário ou os dois: o login aceita qualquer um. Sem e-mail não há convite: a senha inicial é obrigatória. */
export const createBody = z
  .object({
    nome: z.string().trim().min(2).max(120),
    email: emailOpc.optional(),
    usuario: usuarioLogin.optional(),
    perfil,
    /** sem ela (e com e-mail), o usuário recebe um convite por e-mail e define a própria senha */
    senhaTemporaria: z.string().min(12).max(256).optional(),
  })
  .refine((v) => !!(v.email || v.usuario), { message: 'Informe o e-mail, o usuário ou os dois', path: ['usuario'] })
  .refine((v) => !!v.email || !!v.senhaTemporaria, { message: 'Sem e-mail não é possível enviar convite: informe uma senha inicial', path: ['senhaTemporaria'] });

export const updateBody = z
  .object({
    nome: z.string().trim().min(2).max(120).optional(),
    /** `null` remove (desde que sobre o outro) */
    email: emailOpc.nullable().optional(),
    usuario: usuarioLogin.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Informe ao menos um campo');

export const statusBody = z.object({ ativo: z.boolean() });
export const perfilBody = z.object({ perfil });
/** Papel no RH (independe do perfil do financeiro) e o cadastro de colaborador ligado; `rhPapel: null` tira a pessoa do RH. */
export const rhBody = z.object({
  rhPapel: z.enum(['RH', 'CEO', 'GESTOR', 'COLABORADOR']).nullable(),
  colaboradorId: z.string().uuid().nullable().optional(),
});
