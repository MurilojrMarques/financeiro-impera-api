import type { Response } from 'express';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): void {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  ok(res, data, meta, 201);
}

export function noContent(res: Response): void {
  res.status(204).end();
}

export function paginated<T>(res: Response, data: T[], p: PaginationMeta, extra?: Record<string, unknown>): void {
  res.status(200).json({ success: true, data, meta: { ...p, ...(extra ?? {}) } });
}

export function pageMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
