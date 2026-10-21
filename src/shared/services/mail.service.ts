import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

export interface Mensagem {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Caixa de saída em memória: só existe em NODE_ENV=test (permite que os testes leiam links sem enviar nada). */
export const mailOutbox: Mensagem[] = [];

const emProducao = env.NODE_ENV === 'production';
const emTeste = env.NODE_ENV === 'test';

/** Há um canal de e-mail real configurado? (em produção só SMTP conta; "log" nunca é aceito) */
export function emailConfigurado(): boolean {
  if (emTeste) return true;
  if (env.MAIL_TRANSPORT === 'smtp') return !!env.SMTP_HOST;
  return !emProducao;
}

let transporter: Transporter | null = null;
function smtp(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE, // STARTTLS obrigatório quando a porta não é TLS direto
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  return transporter;
}

/**
 * Envia um e-mail transacional. NUNCA lança para o chamador (falha de e-mail não pode revelar se uma conta existe nem derrubar o
 * fluxo): devolve false e registra o erro sem o corpo da mensagem (que contém links de uso único).
 */
export async function enviarEmail(m: Mensagem): Promise<boolean> {
  try {
    if (emTeste) {
      mailOutbox.push(m);
      return true;
    }
    if (env.MAIL_TRANSPORT === 'smtp') {
      if (!env.SMTP_HOST) throw new Error('SMTP_HOST não configurado');
      await smtp().sendMail({ from: env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
      return true;
    }
    if (emProducao) {
      logger.error({ assunto: m.subject }, 'E-mail não enviado: em produção configure MAIL_TRANSPORT=smtp e SMTP_HOST');
      return false;
    }
    // desenvolvimento: mostra o texto (inclui o link de uso único) no log do servidor
    logger.info({ para: m.to, assunto: m.subject, texto: m.text }, 'E-mail (transporte "log", só desenvolvimento)');
    return true;
  } catch (e) {
    logger.error({ assunto: m.subject, erro: e instanceof Error ? e.message : String(e) }, 'Falha ao enviar e-mail');
    return false;
  }
}
