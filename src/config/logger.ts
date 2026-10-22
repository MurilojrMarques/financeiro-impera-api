import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.senha',
      '*.senhaAtual',
      '*.novaSenha',
      '*.refreshToken',
      '*.token',
      '*.tokenHash',
      '*.accessToken',
      '*.private_key',
      '*.client_email',
    ],
    censor: '[REDACTED]',
  },
});
