import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError, Errors } from '../shared/errors/app-error';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(Errors.notFound('Rota não encontrada'));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let appErr: AppError;
  if (err instanceof AppError) {
    appErr = err;
  } else if (err instanceof MulterError) {
    appErr = new AppError(400, 'UPLOAD_ERROR', 'Falha no upload do arquivo');
  } else if (isBodyParserError(err)) {
    appErr = Errors.badRequest('Corpo da requisição inválido');
  } else {
    logger.error({ err, requestId: req.id, path: req.path }, 'erro não tratado');
    appErr = new AppError(500, 'INTERNAL_ERROR', 'Erro interno do servidor');
  }

  if (appErr.status >= 500 && !(err instanceof AppError)) {
    // já logado acima; nunca devolver stack/SQL
  } else if (appErr.status >= 500) {
    logger.error({ err, requestId: req.id }, 'erro de serviço');
  }

  res.status(appErr.status).json({
    success: false,
    error: {
      code: appErr.code,
      message: appErr.message,
      details: appErr.details ?? [],
      ...(env.NODE_ENV !== 'production' ? { requestId: req.id } : {}),
    },
  });
}

function isBodyParserError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type?.startsWith('entity.') === true;
}
