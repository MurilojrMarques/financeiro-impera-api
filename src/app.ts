import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { buildCorsOptions } from './config/cors';
import { env } from './config/env';
import { logger } from './config/logger';
import { buildOpenApi } from './docs/openapi';
import { authenticate } from './middlewares/auth.middleware';
import { authorize, Roles } from './middlewares/authorization.middleware';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { globalLimiter } from './middlewares/rate-limit.middleware';
import { requestId } from './middlewares/request-id.middleware';
import { healthRouter } from './modules/health/health.routes';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      // URL sem query string: filtros podem conter nomes; nunca registrar corpo/headers sensíveis
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }), res: (res) => ({ statusCode: res.statusCode }) },
    }),
  );
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/health', healthRouter);

  // Swagger: livre em desenvolvimento; em produção só com SWAGGER_ENABLED=true e Bearer de ADMIN.
  if (env.NODE_ENV !== 'production' || env.SWAGGER_ENABLED) {
    const guard = env.NODE_ENV === 'production' ? [authenticate(), authorize(Roles.ADMIN)] : [];
    const spec = buildOpenApi();
    app.get('/docs/openapi.json', ...guard, (_req, res) => void res.json(spec));
    app.use('/docs', ...guard, swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'API Financeira Impera' }));
  }

  app.use('/api/v1', globalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
