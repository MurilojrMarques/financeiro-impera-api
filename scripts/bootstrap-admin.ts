/**
 * Provisiona o PRIMEIRO administrador. Uso:
 *   BOOTSTRAP_ADMIN_EMAIL=voce@empresa.com npm run bootstrap:admin
 *
 * - Não existe senha padrão: se BOOTSTRAP_ADMIN_PASSWORD não for informada, uma senha aleatória é gerada
 *   e exibida UMA vez neste terminal (nunca gravada em log/arquivo).
 * - A conta nasce com troca de senha obrigatória.
 * - Recusa-se a rodar se já existir um ADMIN ativo (use /api/v1/usuarios para criar outros).
 */
import { randomBytes } from 'node:crypto';
import { prisma, closeDatabase } from '../src/config/database';
import { hashPassword, passwordPolicyIssue } from '../src/modules/auth/password.service';

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const nome = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrador';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Defina BOOTSTRAP_ADMIN_EMAIL com um e-mail válido');

  const existente = await prisma.usuario.count({ where: { perfil: 'ADMIN', ativo: true } });
  if (existente > 0) throw new Error('Já existe um administrador ativo; operação cancelada');

  const informada = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const senha = informada && informada.length > 0 ? informada : `${randomBytes(15).toString('base64url')}9a`;
  const problema = passwordPolicyIssue(senha);
  if (problema) throw new Error(problema);

  const usuario = await prisma.usuario.upsert({
    where: { email },
    create: { email, nome, perfil: 'ADMIN', senhaHash: await hashPassword(senha), trocaSenhaObrig: true },
    update: { perfil: 'ADMIN', ativo: true, senhaHash: await hashPassword(senha), trocaSenhaObrig: true },
    select: { id: true, email: true },
  });
  await prisma.auditoria.create({ data: { usuarioId: usuario.id, acao: 'admin.bootstrap', entidade: 'usuario', entidadeId: usuario.id } });

  console.log(`Administrador criado: ${usuario.email}`);
  if (!informada) {
    console.log(`Senha temporária (exibida uma única vez): ${senha}`);
  }
  console.log('No primeiro login será exigida a troca de senha (PATCH /api/v1/auth/change-password).');
}

main()
  .catch((err) => {
    console.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
