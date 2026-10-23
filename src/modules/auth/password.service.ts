import argon2 from 'argon2';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

// Hash descartável para igualar o tempo de resposta quando o e-mail não existe.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('senha-descartavel-nao-usada', OPTIONS);
  return dummyHashPromise;
}

export async function verifyPassword(hash: string | null, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash ?? (await dummyHash()), plain).then((ok) => ok && hash !== null);
  } catch {
    return false;
  }
}

/** Senhas muito comuns (comparadas já normalizadas: minúsculas, sem acento e sem símbolos). Lista curta e local: sem consulta externa. */
const COMUNS = [
  'senha', 'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '123456', '1234567', '12345678', '123456789',
  '1234567890', '123123', 'abc123', 'abcdef', 'admin', 'administrador', 'letmein', 'welcome', 'bemvindo', 'iloveyou', 'eusouvoce',
  'brasil', 'flamengo', 'corinthians', 'palmeiras', 'impera', 'financeiro', 'imperafinanceiro', 'mudar', 'trocar', 'senhaforte',
  'minhasenha', 'novasenha', 'temporaria', 'secret', 'dragon', 'monkey', 'football', 'master', 'login', 'teste', 'test',
];

const normalizar = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ContextoSenha {
  email?: string | null;
  usuario?: string | null;
  nome?: string | null;
}

/**
 * Política de senha (alinhada às diretrizes NIST SP 800-63B e OWASP): 12+ caracteres, letras e números, sem conter dados da conta,
 * sem ser uma senha comum nem uma sequência/repetição trivial. Retorna a mensagem do primeiro problema ou null.
 */
export function passwordPolicyIssue(plain: string, ctx: ContextoSenha = {}): string | null {
  if (plain.length < 12) return 'A senha deve ter ao menos 12 caracteres';
  if (plain.length > 256) return 'A senha deve ter no máximo 256 caracteres';
  if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain)) return 'A senha deve conter letras e números';
  if (/\s/.test(plain.trim()) && plain.trim().length !== plain.length) return 'A senha não deve começar ou terminar com espaço';

  const n = normalizar(plain);
  if (/^(.)\1+$/.test(n) || new Set(n).size < 5) return 'A senha é muito repetitiva';
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|wert|erty|asdf|sdfg|zxcv)/.test(n) && new Set(n).size < 8) return 'A senha contém uma sequência previsível';
  // palavra comum + poucos caracteres/dígitos no fim ("senha1234567", "Password123456", "impera2026")
  const comumComSufixo = (c: string): boolean => n === c || (n.startsWith(c) && (c.length >= 6 ? n.length - c.length <= 6 : /^\d{0,10}$/.test(n.slice(c.length))));
  if (COMUNS.some(comumComSufixo)) return 'Essa senha é muito comum. Escolha outra';

  const partes = [ctx.email?.split('@')[0], ctx.usuario, ...(ctx.nome ? ctx.nome.split(/\s+/) : [])]
    .map((p) => normalizar(p ?? ''))
    .filter((p) => p.length >= 4);
  if (partes.some((p) => n.includes(p))) return 'A senha não pode conter seu nome, usuário ou e-mail';
  return null;
}
