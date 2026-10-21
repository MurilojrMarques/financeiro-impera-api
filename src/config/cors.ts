import type { CorsOptions } from 'cors';
import { env } from './env';

export function buildCorsOptions(): CorsOptions {
  const origens = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    origin(origin, cb) {
      // Requisições sem Origin (curl, server-to-server) não são requisições de navegador.
      if (!origin) return cb(null, true);
      cb(null, origens.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
    maxAge: 600,
  };
}
