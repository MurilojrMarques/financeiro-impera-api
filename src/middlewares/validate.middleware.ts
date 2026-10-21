import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { Errors } from '../shared/errors/app-error';

interface Schemas {
  query?: ZodType;
  body?: ZodType;
  params?: ZodType;
}

/** Valida com Zod e guarda o resultado tipado em req.valid (nunca confia em req.query/body cru). */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: { in: string; path: string; message: string }[] = [];
    for (const key of ['params', 'query', 'body'] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (result.success) {
        req.valid[key] = result.data;
      } else {
        for (const i of result.error.issues) {
          issues.push({ in: key, path: i.path.join('.'), message: i.message });
        }
      }
    }
    if (issues.length > 0) return next(Errors.validation(issues));
    next();
  };
}
