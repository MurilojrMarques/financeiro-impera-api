export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (msg = 'Requisição inválida', details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details),
  validation: (details: unknown, msg = 'Parâmetros inválidos') => new AppError(422, 'VALIDATION_ERROR', msg, details),
  unauthorized: (msg = 'Não autenticado') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Sem permissão') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Recurso não encontrado') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg = 'Conflito', code = 'CONFLICT') => new AppError(409, code, msg),
  tooMany: (msg = 'Limite de requisições excedido') => new AppError(429, 'RATE_LIMITED', msg),
  unavailable: (msg = 'Serviço temporariamente indisponível') => new AppError(503, 'UNAVAILABLE', msg),
  passwordChangeRequired: () =>
    new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'É necessário trocar a senha antes de continuar'),
};
