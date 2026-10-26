import request from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/modules/auth/password.service';
import { resetarLimitadores } from '../../src/middlewares/rate-limit.middleware';
import { mailOutbox } from '../../src/shared/services/mail.service';
import type { PerfilUsuario } from '../../src/generated/prisma/client';

const TABELAS = [
  'rh_documentos', 'rh_folha_itens', 'rh_folha_competencias', 'rh_movimentacoes', 'rh_faixas_salariais', 'rh_usuarios_legado', 'rh_colaboradores',
  'auditoria', 'sessoes', 'anexos_custo', 'custos_operacionais', 'recorrencias_custo', 'regras_custo', 'categorias_custo',
  'redtrack_conversoes', 'venda_eventos', 'venda_produtos', 'vendas', 'afiliado_aliases', 'regras_comissao_afiliado',
  'afiliados', 'lojas', 'produtos', 'regras_classificacao', 'registros_importados', 'erros_importacao', 'sincronizacoes',
  'sincronizacao_cursor', 'fontes_dados', 'configuracoes_financeiras', 'tokens_usuario', 'senhas_historico', 'usuarios',
];

export async function resetLimiters(): Promise<void> {
  resetarLimitadores();
}

export async function resetDb(): Promise<void> {
  await resetLimiters();
  mailOutbox.length = 0;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABELAS.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export const app = createApp();
export const SENHA = 'Senha-Forte-123';

export async function criarUsuario(perfil: PerfilUsuario, opts: { email?: string; trocaSenha?: boolean; ativo?: boolean } = {}) {
  const email = opts.email ?? `${perfil.toLowerCase()}@teste.local`;
  const u = await prisma.usuario.create({
    data: { email, nome: `Usuário ${perfil}`, perfil, senhaHash: await hashPassword(SENHA), trocaSenhaObrig: opts.trocaSenha ?? false, ativo: opts.ativo ?? true },
  });
  return { ...u, email }; // nos testes o usuário sempre tem e-mail
}

/** `credencial` = e-mail ou nome de usuário. */
export async function login(credencial: string, senha = SENHA) {
  const res = await request(app).post('/api/v1/auth/login').send({ login: credencial, senha });
  return res;
}

/** Cria usuário do perfil e devolve o header Authorization pronto. */
export async function tokenDe(perfil: PerfilUsuario): Promise<string> {
  const u = await criarUsuario(perfil, { email: `${perfil.toLowerCase()}@teste.local` });
  const res = await login(u.email);
  return `Bearer ${res.body.data.accessToken}`;
}
