/**
 * Cria o login de cada colaborador ATIVO do RH que ainda não tem acesso (perfil SEM_FINANCEIRO + papel de RH).
 *
 * Senha inicial (decisão de 26/10/2026): primeiro nome (minúsculas, sem acento) + data de nascimento DDMMAAAA, ex.: "ana15031990".
 * TODOS são obrigados a trocar a senha no primeiro acesso. Exceção por segurança: contas com papel RH ou CEO (enxergam salários de todos)
 * recebem uma senha ALEATÓRIA, gravada só em `storage/rh/credenciais-iniciais.txt` (fora do Git), porque uma senha previsível ali permitiria
 * que qualquer colega assumisse a conta antes do dono.
 *
 * Quem já tem usuário com o mesmo e-mail é só VINCULADO (colaborador + papel); a senha dele não muda.
 * Login por e-mail (se o colaborador tiver) e por usuário `primeiro.ultimo`.
 *
 *   npm run rh:usuarios              → simulação
 *   npm run rh:usuarios -- --aplicar → grava
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RhPapel } from '../src/generated/prisma/client';
import { closeDatabase, prisma } from '../src/config/database';
import { hashPassword } from '../src/modules/auth/password.service';

const aplicar = process.argv.includes('--aplicar');
const semAcento = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const partesDoNome = (nome: string): string[] => nome.trim().split(/\s+/).map(semAcento).filter(Boolean);
const ddmmaaaa = (d: Date): string => `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`;
const aleatoria = (): string => `${randomBytes(9).toString('base64url')}a1`;

async function main(): Promise<void> {
  const colabs = await prisma.rhColaborador.findMany({ where: { demissao: null, usuario: null }, orderBy: { nome: 'asc' }, include: { _count: { select: { equipe: true } } } });
  const legados = await prisma.rhUsuarioLegado.findMany();
  const porColab = new Map(legados.filter((l) => l.colaboradorId).map((l) => [l.colaboradorId!, l]));
  const porEmail = new Map(legados.filter((l) => l.email).map((l) => [l.email!.toLowerCase(), l]));

  const existentes = await prisma.usuario.findMany();
  const usadosUsuario = new Set((await prisma.usuario.findMany({ where: { usuario: { not: null } }, select: { usuario: true } })).map((u) => u.usuario!));
  const usadosEmail = new Set((await prisma.usuario.findMany({ where: { email: { not: null } }, select: { email: true } })).map((u) => u.email!));

  const papelDe = (c: (typeof colabs)[number]): RhPapel => {
    // o cargo manda: quem é CEO ou RH tem esse papel (acessa salários), mesmo que no sistema antigo fosse "colaborador"
    if ((c.cargoBase ?? '').toUpperCase() === 'CEO') return 'CEO';
    if ((c.cargoBase ?? '').toUpperCase() === 'RH') return 'RH';
    const legado = porColab.get(c.id) ?? (c.email ? porEmail.get(c.email.toLowerCase()) : undefined);
    const p = legado?.papel;
    if (p === 'rh') return 'RH';
    if (p === 'ceo') return 'CEO';
    if (p === 'gestor') return 'GESTOR';
    if (p === 'colaborador') return 'COLABORADOR';
    return c._count.equipe > 0 ? 'GESTOR' : 'COLABORADOR';
  };

  const credenciais: string[] = [];
  const logins: string[] = ['nome;usuario;email;papel;senha_inicial'];
  let criados = 0;
  let vinculados = 0;
  const contagem = new Map<string, number>();

  for (const c of colabs) {
    const papel = papelDe(c);
    contagem.set(papel, (contagem.get(papel) ?? 0) + 1);
    const email = c.email && !usadosEmail.has(c.email.toLowerCase()) ? c.email.toLowerCase() : null;

    // já existe um usuário com este e-mail (ex.: conta criada à mão): só vincula
    let existente = c.email ? await prisma.usuario.findUnique({ where: { email: c.email.toLowerCase() } }) : null;
    if (!existente) {
      // sem e-mail igual: usuário existente cujo nome é o primeiro nome deste colaborador, se for único dos dois lados (conferir no relatório)
      const primeiroNome = partesDoNome(c.nome)[0];
      const mesmos = colabs.filter((x) => partesDoNome(x.nome)[0] === primeiroNome);
      const candidatos = existentes.filter((u) => !u.colaboradorId && semAcento(u.nome) === primeiroNome);
      if (mesmos.length === 1 && candidatos.length === 1) {
        existente = candidatos[0]!;
        console.log(`  vínculo por nome (conferir): usuário "${existente.nome}" ↔ colaborador "${c.nome}"`);
      }
    }
    if (existente && !existente.colaboradorId) {
      vinculados++;
      if (aplicar) await prisma.usuario.update({ where: { id: existente.id }, data: { colaboradorId: c.id, rhPapel: papel } });
      logins.push(`${c.nome};${existente.usuario ?? ''};${existente.email ?? ''};${papel};(mantida a senha atual)`);
      continue;
    }

    const [primeiro = 'user', ...resto] = partesDoNome(c.nome);
    const ultimo = resto.length ? resto[resto.length - 1]! : '';
    let usuario = ultimo ? `${primeiro}.${ultimo}` : primeiro;
    let n = 2;
    while (usadosUsuario.has(usuario) || usuario.length < 3) usuario = `${primeiro}.${ultimo || 'x'}${n++}`;
    usadosUsuario.add(usuario);
    if (email) usadosEmail.add(email);

    const privilegiado = papel === 'RH' || papel === 'CEO';
    const previsivel = !privilegiado && c.nascimento ? `${primeiro}${ddmmaaaa(c.nascimento)}` : null;
    const senha = previsivel ?? aleatoria();
    if (!previsivel) credenciais.push(`${c.nome} | ${email ?? usuario} | ${senha}`);
    logins.push(`${c.nome};${usuario};${email ?? ''};${papel};${previsivel ? 'primeiro nome + nascimento (DDMMAAAA)' : 'aleatória (ver credenciais-iniciais.txt)'}`);

    criados++;
    if (aplicar) {
      await prisma.usuario.create({
        data: { nome: c.nome, email, usuario, perfil: 'SEM_FINANCEIRO', rhPapel: papel, colaboradorId: c.id, senhaHash: await hashPassword(senha), trocaSenhaObrig: true },
      });
    }
  }

  console.log(`${aplicar ? 'APLICADO' : 'SIMULAÇÃO'}: ${colabs.length} colaboradores ativos sem login → ${criados} logins novos, ${vinculados} vinculados a usuário existente`);
  console.log('papéis:', [...contagem.entries()].map(([k, v]) => `${k}(${v})`).join(', '));
  console.log(`senha aleatória (RH/CEO ou sem nascimento): ${credenciais.length}`);
  if (aplicar) {
    const dir = path.resolve(process.env.RH_STORAGE_DIR ?? './storage/rh');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'logins.csv'), `${logins.join('\n')}\n`);
    if (credenciais.length) await writeFile(path.join(dir, 'credenciais-iniciais.txt'), `Senhas iniciais (troca obrigatória no 1º acesso). Entregue em mãos e apague este arquivo.\n\n${credenciais.join('\n')}\n`);
    console.log(`arquivos: ${path.join(dir, 'logins.csv')}${credenciais.length ? ` e ${path.join(dir, 'credenciais-iniciais.txt')}` : ''}`);
  } else console.log('\nNada foi gravado. Rode com --aplicar para gravar.');
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
