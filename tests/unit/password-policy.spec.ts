import { describe, expect, it } from 'vitest';
import { passwordPolicyIssue } from '../../src/modules/auth/password.service';
import { emailConvite, emailRedefinicao, linkConvite, linkRedefinicao } from '../../src/shared/services/mail.templates';

describe('política de senha', () => {
  it.each([
    ['Cobalto-Pivo-Tinta-47'],
    ['Lume-Verde-Rio-9281'],
    ['correct horse battery 7'],
    ['Zq8#mLw2vPx9'],
  ])('aceita %s', (s) => expect(passwordPolicyIssue(s)).toBeNull());

  it.each([
    ['Curta1', /12 caracteres/],
    ['somenteletrasaquiii', /letras e números/],
    ['123456789012', /letras e números/],
    ['aaaaaaaaaaaa1', /repetitiva/],
    ['senha1234567', /comum|sequência/],
    ['Password123456', /comum/],
    ['Impera@123456', /comum/],
    ['x'.repeat(257) + '1', /no máximo 256/],
  ])('recusa %s', (s, motivo) => expect(passwordPolicyIssue(s)).toMatch(motivo));

  it('não permite conter o nome nem a parte local do e-mail', () => {
    const ctx = { email: 'carla.mendes@empresa.com', nome: 'Carla Mendes' };
    expect(passwordPolicyIssue('Carla-Mendes-2026', ctx)).toMatch(/nome, usuário ou e-mail/);
    expect(passwordPolicyIssue('xx-carlamendes-99-yy', ctx)).toMatch(/nome, usuário ou e-mail/);
    expect(passwordPolicyIssue('Cobalto-Pivo-Tinta-47', ctx)).toBeNull();
  });
});

describe('modelos de e-mail', () => {
  const token = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12';

  it('o token vai no fragmento da URL e é codificado', () => {
    expect(linkRedefinicao(token)).toBe(`http://localhost:5173/redefinir-senha#token=${token}`);
    expect(linkConvite('a b/c')).toContain('#token=a%20b%2Fc');
  });

  it('escapa HTML do nome (sem injeção) e tem versão em texto', () => {
    const m = emailRedefinicao('a@b.com', '<img src=x onerror=alert(1)>', token);
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
    expect(m.text).toContain(linkRedefinicao(token));
    expect(m.subject).toMatch(/Redefinição de senha/);
  });

  it('convite informa perfil e quem convidou, sem a senha de ninguém', () => {
    const m = emailConvite('a@b.com', 'Maria', 'FINANCEIRO', token, 'Murilo');
    expect(m.text).toMatch(/Murilo/);
    expect(m.text).toMatch(/FINANCEIRO/);
    expect(m.text).toContain(linkConvite(token));
    expect(m.text).not.toMatch(/senha:/i);
  });
});
