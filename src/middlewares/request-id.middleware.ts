import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.id = randomUUID();
  req.valid = {};
  res.setHeader('X-Request-Id', req.id);
  next();
}
