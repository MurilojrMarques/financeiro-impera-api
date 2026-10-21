import { z, type ZodType } from 'zod';
import { ROUTES, type RouteDoc } from './registry';

type Json = Record<string, unknown>;

function jsonSchema(schema: ZodType, io: 'input' | 'output' = 'input'): Json {
  const js = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-7' }) as Json;
  delete js.$schema;
  return js;
}

function queryParameters(schema: ZodType): Json[] {
  const js = jsonSchema(schema) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, sch]) => ({
    name,
    in: 'query',
    required: js.required?.includes(name) ?? false,
    schema: sch,
  }));
}

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}');

const FILTRO_DESCRICAO =
  'Filtros padronizados: de/ate (AAAA-MM-DD, padrão = mês atual em America/Sao_Paulo, máx. 366 dias), loja, produto, grupo, afiliadoId, metodo, status, origem, tipo, modo (APROVADAS | MOVIMENTACAO), page, limit, sortBy (whitelist), sortOrder.';

function operation(route: RouteDoc): Json {
  const params = [...(route.path.match(/:([A-Za-z]+)/g) ?? []).map((p) => ({ name: p.slice(1), in: 'path', required: true, schema: { type: 'string' } }))];
  if (route.query) params.push(...(queryParameters(route.query) as never[]));
  const publico = !route.papeis;
  const okStatus = route.status ?? 200;
  return {
    tags: [route.tag],
    summary: route.summary,
    description: [
      route.descricao,
      route.papeis ? `Perfis permitidos: ${route.papeis.join(', ')}.` : 'Rota pública.',
      route.query && route.path !== '/usuarios' ? FILTRO_DESCRICAO : undefined,
    ].filter(Boolean).join('\n\n'),
    ...(publico ? { security: [] } : { security: [{ bearerAuth: [] }] }),
    parameters: params,
    ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(route.body) } } } } : {}),
    responses: {
      [okStatus]: okStatus === 204
        ? { description: 'Sem conteúdo' }
        : { description: 'Sucesso', content: { 'application/json': { schema: { $ref: route.paginado ? '#/components/schemas/RespostaPaginada' : '#/components/schemas/RespostaSucesso' } } } },
      ...(publico ? {} : { 401: { $ref: '#/components/responses/Erro' }, 403: { $ref: '#/components/responses/Erro' } }),
      ...(route.body || route.query ? { 422: { $ref: '#/components/responses/Erro' } } : {}),
      429: { $ref: '#/components/responses/Erro' },
      500: { $ref: '#/components/responses/Erro' },
    },
  };
}

export function buildOpenApi(): Json {
  const paths: Record<string, Record<string, Json>> = {};
  const healthPaths: Record<string, Record<string, Json>> = {};
  for (const r of ROUTES) {
    const target = r.path.startsWith('/health') ? healthPaths : paths;
    const p = toOpenApiPath(r.path);
    (target[p] ??= {})[r.method] = operation(r);
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'API Financeira Impera',
      version: '1.0.0',
      description: [
        'Backend financeiro: consulta PostgreSQL alimentado pela planilha Google Sheets (Pagah/RedTrack).',
        '',
        '**Autenticação**: Access Token JWT (Bearer, curta duração). O Refresh Token é rotacionado a cada uso e trafega em cookie `rt` (HttpOnly, Secure, SameSite); `POST /auth/refresh` e `/auth/logout` exigem o header `X-CSRF-Token` igual ao cookie `csrf`.',
        '',
        '**Critérios financeiros (`modo`)**: `APROVADAS` aproxima o painel Pagah (pedidos pagos no período pelo status atual). `MOVIMENTACAO` (padrão) = pagamentos do período − perdas reconhecidas na data do evento. Nunca misture os dois.',
        '',
        '**Valores monetários** são sempre centavos inteiros (`*Centavos`). **Grupos de receita** são mutuamente exclusivos; `backendTotal = backendOutros + callCenter` é agregado e nunca deve ser somado de novo.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1', description: 'API' }],
    tags: [...new Set(ROUTES.map((r) => r.tag))].map((name) => ({ name })),
    // health fica na raiz (/health/...), fora do prefixo /api/v1: servidor próprio no path item
    paths: { ...paths, ...Object.fromEntries(Object.entries(healthPaths).map(([k, v]) => [k, { servers: [{ url: '/' }], ...v }])) },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        RespostaSucesso: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {},
            meta: {
              type: 'object',
              properties: {
                periodo: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } } },
                timezone: { type: 'string', example: 'America/Sao_Paulo' },
                criterioFinanceiro: { type: 'string', enum: ['APROVADAS', 'MOVIMENTACAO'] },
                metodologia: { type: 'string' },
                ultimaSincronizacao: { type: 'string', format: 'date-time', nullable: true },
                dadosDesatualizados: { type: 'boolean' },
              },
            },
          },
        },
        RespostaPaginada: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'array', items: {} },
            meta: {
              type: 'object',
              properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } },
            },
          },
        },
        Erro: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: { code: { type: 'string', example: 'VALIDATION_ERROR' }, message: { type: 'string' }, details: { type: 'array', items: {} } },
            },
          },
        },
      },
      responses: { Erro: { description: 'Erro', content: { 'application/json': { schema: { $ref: '#/components/schemas/Erro' } } } } },
    },
  };
}
