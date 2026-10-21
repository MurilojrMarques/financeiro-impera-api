import request from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/modules/auth/password.service';
import { globalLimiter, loginLimiter, sensitiveLimiter, syncTriggerLimiter } from '../../src/middlewares/rate-limit.middleware';
import type { PerfilUsuario } from '../../src/generated/prisma/client';

const TABELAS = [
  'auditoria', 'sessoes', 'anexos_custo', 'custos_operacionais', 'recorrencias_custo', 'regras_custo', 'categorias_custo',
  'redtrack_conversoes', 'venda_eventos', 'venda_produtos', 'vendas', 'afiliado_aliases', 'regras_comissao_afiliado',
  'afiliados', 'lojas', 'produtos', 'regras_classificacao', 'registros_importados', 'erros_importacao', 'sincronizacoes',
  'sincronizacao_cursor', 'fontes_dados', 'configuracoes_financeiras', 'usuarios',
];

export async function resetLimiters(): Promise<void> {
  for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) for (const l of [loginLimiter, globalLimiter, sensitiveLimiter, syncTriggerLimiter]) await l.resetKey(ip);
}

export async function resetDb(): Promise<void> {
  await resetLimiters();
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABELAS.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export const app = createApp();
export const SENHA = 'Senha-Forte-123';

export async function criarUsuario(perfil: PerfilUsuario, opts: { email?: string; trocaSenha?: boolean; ativo?: boolean } = {}) {
  const email = opts.email ?? `${perfil.toLowerCase()}@teste.local`;
  return prisma.usuario.create({
    data: { email, nome: `Usuário ${perfil}`, perfil, senhaHash: await hashPassword(SENHA), trocaSenhaObrig: opts.trocaSenha ?? false, ativo: opts.ativo ?? true },
  });
}

export async function login(email: string, senha = SENHA) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, senha });
  return res;
}

/** Cria usuário do perfil e devolve o header Authorization pronto. */
export async function tokenDe(perfil: PerfilUsuario): Promise<string> {
  const u = await criarUsuario(perfil, { email: `${perfil.toLowerCase()}@teste.local` });
  const res = await login(u.email);
  return `Bearer ${res.body.data.accessToken}`;
}
