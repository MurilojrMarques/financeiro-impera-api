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

/** Política mínima: 12+ caracteres, com letras e números. */
export function passwordPolicyIssue(plain: string): string | null {
  if (plain.length < 12) return 'A senha deve ter ao menos 12 caracteres';
  if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain)) return 'A senha deve conter letras e números';
  return null;
}
