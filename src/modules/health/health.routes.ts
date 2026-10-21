import { Router } from 'express';
import { checkDatabase } from '../../config/database';

/** Públicos e mínimos: sem versão, sem detalhes de dependências. */
export const healthRouter = Router();

healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

healthRouter.get('/ready', async (_req, res) => {
  const ok = await checkDatabase();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
});
