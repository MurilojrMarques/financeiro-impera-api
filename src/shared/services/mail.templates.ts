import { env } from '../../config/env';
import type { Mensagem } from './mail.service';

const escapar = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const base = () => env.APP_PUBLIC_URL.replace(/\/+$/, '');

/** O token vai no FRAGMENTO (#): não é enviado ao servidor, nem aparece em logs de acesso ou no cabeçalho Referer. */
export const linkRedefinicao = (token: string): string => `${base()}/redefinir-senha#token=${encodeURIComponent(token)}`;
export const linkConvite = (token: string): string => `${base()}/ativar-conta#token=${encodeURIComponent(token)}`;

interface Corpo {
  assunto: string;
  titulo: string;
  paragrafos: string[];
  botao?: { rotulo: string; url: string };
  rodape: string[];
}

function montar(para: string, c: Corpo): Mensagem {
  const texto = [
    c.titulo,
    '',
    ...c.paragrafos,
    ...(c.botao ? ['', `${c.botao.rotulo}: ${c.botao.url}`] : []),
    '',
    ...c.rodape,
    '',
    '— Financeiro Impera',
  ].join('\n');

  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;padding-bottom:16px">${escapar(c.titulo)}</td></tr>
${c.paragrafos.map((p) => `<tr><td style="font-size:15px;line-height:1.6;padding-bottom:12px">${escapar(p)}</td></tr>`).join('')}
${c.botao ? `<tr><td style="padding:16px 0"><a href="${escapar(c.botao.url)}" style="background:#b8923a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;display:inline-block">${escapar(c.botao.rotulo)}</a></td></tr>
<tr><td style="font-size:12px;color:#6b7280;padding-bottom:12px;word-break:break-all">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${escapar(c.botao.url)}</td></tr>` : ''}
${c.rodape.map((p) => `<tr><td style="font-size:12px;line-height:1.5;color:#6b7280;padding-top:8px">${escapar(p)}</td></tr>`).join('')}
<tr><td style="font-size:12px;color:#9ca3af;padding-top:20px">Financeiro Impera</td></tr>
</table></td></tr></table></body></html>`;

  return { to: para, subject: c.assunto, text: texto, html };
}

export interface ContextoAcesso {
  ip?: string | null;
  quando?: Date;
}

const quandoTexto = (d: Date): string => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

export function emailRedefinicao(para: string, nome: string, token: string): Mensagem {
  return montar(para, {
    assunto: 'Redefinição de senha — Financeiro Impera',
    titulo: 'Redefinir sua senha',
    paragrafos: [
      `Olá, ${nome}.`,
      `Recebemos um pedido para redefinir a senha da sua conta. O link abaixo vale por ${env.RESET_TOKEN_TTL_MINUTES} minutos e só pode ser usado uma vez.`,
    ],
    botao: { rotulo: 'Criar nova senha', url: linkRedefinicao(token) },
    rodape: [
      'Se você não pediu isso, ignore este e-mail: sua senha continua a mesma e ninguém consegue acessá-la apenas por este aviso.',
      'Nunca compartilhe este link. Nossa equipe não pede sua senha por e-mail ou telefone.',
    ],
  });
}

export function emailConvite(para: string, nome: string, perfil: string, token: string, convidadoPor: string): Mensagem {
  return montar(para, {
    assunto: 'Você foi convidado para o Financeiro Impera',
    titulo: 'Ative sua conta',
    paragrafos: [
      `Olá, ${nome}.`,
      `${convidadoPor} criou um acesso para você ao Financeiro Impera com o perfil ${perfil}. Defina sua senha para ativar a conta. O link vale por ${env.INVITE_TOKEN_TTL_HOURS} horas e só pode ser usado uma vez.`,
    ],
    botao: { rotulo: 'Ativar conta', url: linkConvite(token) },
    rodape: ['Se você não esperava este convite, ignore este e-mail: nenhuma conta será ativada sem a criação da senha.'],
  });
}

export function emailSenhaAlterada(para: string, nome: string, ctx: ContextoAcesso): Mensagem {
  const quando = quandoTexto(ctx.quando ?? new Date());
  return montar(para, {
    assunto: 'Sua senha foi alterada — Financeiro Impera',
    titulo: 'Senha alterada',
    paragrafos: [
      `Olá, ${nome}.`,
      `A senha da sua conta foi alterada em ${quando}${ctx.ip ? ` (IP ${ctx.ip})` : ''}. Por segurança, todas as sessões abertas foram encerradas.`,
    ],
    rodape: ['Não foi você? Peça uma nova redefinição de senha imediatamente e avise um administrador.'],
  });
}

export function emailContaBloqueada(para: string, nome: string, minutos: number, ctx: ContextoAcesso): Mensagem {
  return montar(para, {
    assunto: 'Tentativas de acesso suspeitas — Financeiro Impera',
    titulo: 'Conta bloqueada temporariamente',
    paragrafos: [
      `Olá, ${nome}.`,
      `Houve várias tentativas de entrar na sua conta com a senha errada${ctx.ip ? ` (último IP ${ctx.ip})` : ''}. Por segurança, novos acessos ficam bloqueados por ${minutos} minutos.`,
    ],
    rodape: ['Se não foi você, redefina a senha pela opção "Esqueci minha senha" e avise um administrador.'],
  });
}
