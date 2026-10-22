import type { ZodType } from 'zod';
import { adminRoutesSchemas } from './registry-schemas';

export type Papel = 'ADMIN' | 'FINANCEIRO' | 'ANALISTA' | 'LEITURA';

export interface RouteDoc {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string; // formato Express (/vendas/:pedido), relativo a /api/v1
  tag: string;
  summary: string;
  papeis?: Papel[]; // omitido = rota pública
  query?: ZodType;
  body?: ZodType;
  paginado?: boolean;
  status?: number;
  descricao?: string;
}

const S = adminRoutesSchemas;
const TODOS: Papel[] = ['ADMIN', 'FINANCEIRO', 'ANALISTA', 'LEITURA'];
const ANALISE: Papel[] = ['ADMIN', 'FINANCEIRO', 'ANALISTA'];
const FIN: Papel[] = ['ADMIN', 'FINANCEIRO'];
const ADM: Papel[] = ['ADMIN'];

const r = (method: RouteDoc['method'], path: string, tag: string, summary: string, papeis: Papel[] | undefined, extra: Partial<RouteDoc> = {}): RouteDoc => ({
  method, path, tag, summary, papeis, ...extra,
});
const rel = (path: string, tag: string, summary: string, papeis: Papel[] = ANALISE, extra: Partial<RouteDoc> = {}) =>
  r('get', path, tag, summary, papeis, { query: S.filtros, ...extra });
const lst = (path: string, tag: string, summary: string, papeis: Papel[] = ANALISE) => rel(path, tag, summary, papeis, { paginado: true });

export const ROUTES: RouteDoc[] = [
  // ── Saúde (público, mínimo)
  { method: 'get', path: '/health/live', tag: 'Saúde', summary: 'Liveness' },
  { method: 'get', path: '/health/ready', tag: 'Saúde', summary: 'Readiness (verifica PostgreSQL)' },

  // ── Autenticação
  r('post', '/auth/login', 'Autenticação', 'Login (Access Token no corpo; Refresh Token em cookie HttpOnly)', undefined, { body: S.login }),
  r('post', '/auth/refresh', 'Autenticação', 'Rotaciona o Refresh Token (cookie + X-CSRF-Token, ou corpo)', undefined, { body: S.refresh }),
  r('post', '/auth/logout', 'Autenticação', 'Encerra a sessão atual', undefined, { body: S.refresh, status: 204 }),
  r('post', '/auth/logout-all', 'Autenticação', 'Encerra todas as sessões do usuário', TODOS, { status: 204 }),
  r('get', '/auth/me', 'Autenticação', 'Usuário autenticado', TODOS),
  r('get', '/auth/config', 'Autenticação', 'Recursos de conta disponíveis (ex.: recuperação de senha por e-mail)', undefined),
  r('post', '/auth/forgot-password', 'Autenticação', 'Esqueci minha senha: envia link de uso único por e-mail (resposta 202 sempre igual)', undefined, { body: S.forgotPassword, status: 202 }),
  r('post', '/auth/link/validar', 'Autenticação', 'Confere se um link de redefinição/convite ainda é válido', undefined, { body: S.token }),
  r('post', '/auth/reset-password', 'Autenticação', 'Define a nova senha com o link recebido por e-mail (encerra todas as sessões)', undefined, { body: S.resetPassword, status: 204 }),
  r('post', '/auth/activate', 'Autenticação', 'Ativa a conta convidada definindo a senha pelo link recebido por e-mail', undefined, { body: S.resetPassword, status: 204 }),
  r('patch', '/auth/change-password', 'Autenticação', 'Troca de senha (obrigatória para senha temporária)', TODOS, { body: S.changePassword, status: 204 }),
  r('get', '/auth/sessions', 'Autenticação', 'Sessões ativas do usuário', TODOS),
  r('delete', '/auth/sessions/:id', 'Autenticação', 'Revoga uma sessão do usuário', TODOS, { status: 204 }),

  // ── Usuários (ADMIN)
  r('get', '/usuarios', 'Usuários', 'Lista usuários (paginação e busca)', ADM, { query: S.usuariosLista, paginado: true }),
  r('post', '/usuarios', 'Usuários', 'Cria usuário com senha temporária (troca obrigatória)', ADM, { body: S.usuariosCriar, status: 201 }),
  r('get', '/usuarios/:id', 'Usuários', 'Detalha usuário', ADM),
  r('patch', '/usuarios/:id', 'Usuários', 'Atualiza nome/e-mail', ADM, { body: S.usuariosAtualizar }),
  r('patch', '/usuarios/:id/status', 'Usuários', 'Ativa/desativa usuário (revoga sessões ao desativar)', ADM, { body: S.usuariosStatus }),
  r('patch', '/usuarios/:id/perfil', 'Usuários', 'Altera o perfil', ADM, { body: S.usuariosPerfil }),
  r('post', '/usuarios/:id/reenviar-convite', 'Usuários', 'Reenvia o convite por e-mail (o link anterior deixa de valer)', ADM),
  r('post', '/usuarios/:id/redefinir-senha', 'Usuários', 'Envia ao usuário o link para criar nova senha (o admin nunca vê a senha)', ADM),
  r('post', '/usuarios/:id/desbloquear', 'Usuários', 'Remove o bloqueio temporário por tentativas de login', ADM),
  r('delete', '/usuarios/:id', 'Usuários', 'Desativação lógica (preserva auditoria)', ADM, { status: 204 }),

  // ── Dashboard
  rel('/dashboard/resumo', 'Dashboard', 'Resumo geral: KPIs, receitas por grupo e alertas', TODOS),
  rel('/dashboard/kpis', 'Dashboard', 'KPIs principais (custos/resultado só FINANCEIRO/ADMIN)', TODOS),
  rel('/dashboard/evolucao', 'Dashboard', 'Evolução por dia/semana/mês', TODOS, { query: S.dashEvolucao }),
  rel('/dashboard/comparativo', 'Dashboard', 'Período atual × anterior de mesma duração', TODOS),
  rel('/dashboard/distribuicao-receitas', 'Dashboard', 'Participação de cada grupo (soma 100%)', TODOS),
  rel('/dashboard/receitas-por-grupo', 'Dashboard', 'Grupos exclusivos + backendTotal agregado', TODOS),
  rel('/dashboard/opcoes', 'Dashboard', 'Valores distintos de loja/produto/origem/campanha/atendente no período (listas dos filtros)', TODOS, { query: S.dashOpcoes }),
  rel('/dashboard/receitas-por-loja', 'Dashboard', 'Receita por loja', TODOS),
  rel('/dashboard/indicadores', 'Dashboard', 'Catálogo de indicadores com metodologia', TODOS),

  // ── Vendas
  lst('/vendas', 'Vendas', 'Lista vendas pagas no período (filtros e paginação)'),
  rel('/vendas/resumo', 'Vendas', 'Resumo'),
  rel('/vendas/por-dia', 'Vendas', 'Série por dia'),
  rel('/vendas/por-hora', 'Vendas', 'Série por hora do dia'),
  rel('/vendas/por-semana', 'Vendas', 'Série por semana'),
  rel('/vendas/por-loja', 'Vendas', 'Por loja'),
  rel('/vendas/por-produto', 'Vendas', 'Por produto/kit'),
  rel('/vendas/por-metodo', 'Vendas', 'Por método de pagamento'),
  rel('/vendas/por-status', 'Vendas', 'Por status atual'),
  rel('/vendas/por-origem', 'Vendas', 'Por origem'),
  rel('/vendas/:pedido', 'Vendas', 'Detalhe do pedido (sem dados pessoais)'),
  rel('/vendas/:pedido/eventos', 'Vendas', 'Eventos do pedido (pagamento/estorno/chargeback)', ANALISE, { query: undefined }),
  rel('/vendas/:pedido/conciliacao', 'Vendas', 'Procedência de cada valor do pedido'),

  // ── Front
  rel('/front/resumo', 'Front', 'Resumo do Front (compras, upsells, downsells)'),
  lst('/front/vendas', 'Front', 'Vendas Front'),
  lst('/front/compras', 'Front', 'Compras iniciais'),
  lst('/front/upsells', 'Front', 'Upsells'),
  lst('/front/downsells', 'Front', 'Downsells'),
  rel('/front/conversao-upsell', 'Front', 'Upsell ÷ compra inicial, por loja, sem afiliados'),
  rel('/front/por-loja', 'Front', 'Por loja'),
  rel('/front/por-produto', 'Front', 'Por produto'),
  rel('/front/por-campanha', 'Front', 'Por campanha'),
  rel('/front/por-anuncio', 'Front', 'Por anúncio'),
  rel('/front/evolucao', 'Front', 'Evolução diária'),
  rel('/front/comparativo', 'Front', 'Comparativo com período anterior'),

  // ── Back-end
  rel('/backend/resumo', 'Back-end', 'Resumo de BACKEND_OUTROS: SMS, e-mail e disparo (não inclui Call Center nem Recuperação)'),
  rel('/backend/total', 'Back-end', 'backendTotal = backendOutros + callCenter (agregado)'),
  lst('/backend/vendas', 'Back-end', 'Vendas de Back-end Outros'),
  rel('/backend/por-canal', 'Back-end', 'Por canal (rótulo da regra de classificação)'),
  rel('/backend/por-origem', 'Back-end', 'Por origem'),
  rel('/backend/por-loja', 'Back-end', 'Por loja'),
  rel('/backend/por-produto', 'Back-end', 'Por produto'),
  rel('/backend/evolucao', 'Back-end', 'Evolução diária'),
  rel('/backend/comparativo', 'Back-end', 'Comparativo'),
  lst('/backend/nao-classificadas', 'Back-end', 'Vendas NAO_CLASSIFICADA (pendências)'),

  // ── Call Center
  rel('/call-center/resumo', 'Call Center', 'Cards: receita, pedidos, ticket, custos/margem (FINANCEIRO)'),
  lst('/call-center/vendas', 'Call Center', 'Vendas do Call Center'),
  rel('/call-center/por-atendente', 'Call Center', 'Por atendente (somente se a planilha trouxer o campo)'),
  rel('/call-center/por-loja', 'Call Center', 'Por loja'),
  rel('/call-center/por-produto', 'Call Center', 'Por produto'),
  rel('/call-center/por-metodo', 'Call Center', 'Por método de pagamento'),
  rel('/call-center/por-tipo-atendimento', 'Call Center', 'Por tipo de atendimento'),
  rel('/call-center/recuperacoes', 'Call Center', 'Recuperações Pix/boleto/abandono/outros'),
  rel('/call-center/comissoes', 'Call Center', 'Comissão e taxa do Call Center (campos distintos)'),
  rel('/call-center/custos', 'Call Center', 'Custos atribuídos ao Call Center', FIN),
  rel('/call-center/margem', 'Call Center', 'Margem do Call Center', FIN),
  rel('/call-center/evolucao', 'Call Center', 'Evolução diária'),
  rel('/call-center/comparativo', 'Call Center', 'Comparativo'),

  // ── Afiliados
  rel('/afiliados', 'Afiliados', 'Lista afiliados com métricas (paginação, filtro por nome)', ANALISE, { query: S.afiliadosLista, paginado: true }),
  rel('/afiliados/resumo', 'Afiliados', 'Resumo do grupo'),
  rel('/afiliados/ranking', 'Afiliados', 'Ranking por receita'),
  rel('/afiliados/evolucao', 'Afiliados', 'Evolução diária do grupo'),
  rel('/afiliados/por-loja', 'Afiliados', 'Por loja'),
  rel('/afiliados/comparativo', 'Afiliados', 'Comparativo'),
  r('get', '/afiliados/:id', 'Afiliados', 'Cadastro do afiliado', ANALISE),
  rel('/afiliados/:id/resumo', 'Afiliados', 'Resumo do afiliado'),
  lst('/afiliados/:id/vendas', 'Afiliados', 'Vendas do afiliado'),
  rel('/afiliados/:id/comissoes', 'Afiliados', 'Comissões por fonte'),
  lst('/afiliados/:id/reembolsos', 'Afiliados', 'Reembolsos do afiliado'),
  rel('/afiliados/:id/evolucao', 'Afiliados', 'Evolução do afiliado'),
  r('get', '/afiliados/:id/aliases', 'Afiliados', 'Lista aliases', ANALISE),
  r('post', '/afiliados/:id/aliases', 'Afiliados', 'Cadastra alias (incorpora afiliado auto-criado de mesmo nome normalizado)', ADM, { body: S.afiliadoAlias, status: 201 }),
  r('delete', '/afiliados/:id/aliases/:aliasId', 'Afiliados', 'Remove alias', ADM, { status: 204 }),
  r('get', '/afiliados/:id/regras-comissao', 'Afiliados', 'Regras de comissão (vigência/fonte)', FIN),
  r('post', '/afiliados/:id/regras-comissao', 'Afiliados', 'Cria regra de comissão e recalcula comissões sem fonte confiável', ADM, { body: S.afiliadoRegra, status: 201 }),

  // ── Recuperação de vendas (time interno, sem a taxa do call center)
  rel('/recuperacao/resumo', 'Recuperação', 'Resumo do grupo RECUPERACAO'),
  lst('/recuperacao/vendas', 'Recuperação', 'Vendas de recuperação (paginado)'),
  rel('/recuperacao/por-vendedor', 'Recuperação', 'Receita por vendedor (subcanal)'),
  rel('/recuperacao/por-loja', 'Recuperação', 'Receita por loja'),
  rel('/recuperacao/por-produto', 'Recuperação', 'Receita por produto'),
  rel('/recuperacao/por-metodo', 'Recuperação', 'Receita por método de pagamento'),
  rel('/recuperacao/evolucao', 'Recuperação', 'Evolução por dia'),
  rel('/recuperacao/comparativo', 'Recuperação', 'Período atual × anterior'),

  // ── Tráfego (faturamento Front × investimento × custos)
  rel('/trafego/resumo', 'Tráfego', 'Faturamento Front, investimento (RedTrack), ROAS, custos e sobra do tráfego'),
  r('get', '/trafego/parametros', 'Tráfego', 'Taxas, frete e custo unitário usados no cálculo', ANALISE),
  r('put', '/trafego/parametros', 'Tráfego', 'Atualiza taxas, frete e custo unitário (auditado)', FIN),

  rel('/call-center/receita-custos', 'Call Center', 'Receita do Call Center → taxas, frete, produto → sobra (custos da operação só FINANCEIRO)'),

  // ── RedTrack e campanhas
  r('get', '/redtrack/conversoes', 'RedTrack', 'Conversões sincronizadas', ANALISE, { query: S.redtrack, paginado: true }),
  rel('/redtrack/conciliacao', 'RedTrack', 'Cobertura da conciliação Pagah × RedTrack'),
  r('get', '/redtrack/divergencias', 'RedTrack', 'Divergências (sem venda / payout ≠ comissão)', ANALISE, { query: S.redtrack, paginado: true }),
  rel('/campanhas', 'Campanhas', 'Por campanha'),
  rel('/campanhas/resumo', 'Campanhas', 'Resumo e cobertura de campanha'),
  rel('/campanhas/por-anuncio', 'Campanhas', 'Por anúncio'),
  rel('/campanhas/por-loja', 'Campanhas', 'Por loja'),

  // ── Reembolsos
  lst('/reembolsos', 'Reembolsos', 'Pedidos com perda'),
  rel('/reembolsos/resumo', 'Reembolsos', 'Resumo e limitações de conciliação'),
  lst('/reembolsos/estornos', 'Reembolsos', 'Estornos'),
  lst('/reembolsos/chargebacks', 'Reembolsos', 'Chargebacks'),
  rel('/reembolsos/por-loja', 'Reembolsos', 'Por loja'),
  rel('/reembolsos/por-grupo', 'Reembolsos', 'Por grupo de receita'),
  rel('/reembolsos/evolucao', 'Reembolsos', 'Evolução diária'),

  // ── Custos
  r('get', '/custos', 'Custos', 'Lista lançamentos', FIN, { query: S.custosLista, paginado: true }),
  r('post', '/custos', 'Custos', 'Cria lançamento', FIN, { body: S.custoCriar, status: 201 }),
  rel('/custos/resumo', 'Custos', 'Resumo do período', FIN),
  r('get', '/custos/categorias', 'Custos', 'Lista categorias', FIN),
  r('post', '/custos/categorias', 'Custos', 'Cria categoria', FIN, { body: S.categoriaCriar, status: 201 }),
  r('patch', '/custos/categorias/:id', 'Custos', 'Atualiza categoria', FIN, { body: S.categoriaAtualizar }),
  r('get', '/custos/recorrencias', 'Custos', 'Lista recorrências', FIN),
  r('post', '/custos/recorrencias', 'Custos', 'Cria recorrência', FIN, { body: S.recorrenciaCriar, status: 201 }),
  r('get', '/custos/:id', 'Custos', 'Detalha lançamento', FIN),
  r('patch', '/custos/:id', 'Custos', 'Atualiza lançamento', FIN, { body: S.custoAtualizar }),
  r('delete', '/custos/:id', 'Custos', 'Remove lançamento e anexos', FIN, { status: 204 }),
  r('post', '/custos/:id/anexos', 'Custos', 'Anexa PDF/PNG/JPEG (multipart, campo "arquivo"; MIME real validado)', FIN, { status: 201 }),
  r('get', '/custos/:id/anexos', 'Custos', 'Lista anexos', FIN),
  r('get', '/custos/:id/anexos/:anexoId/download', 'Custos', 'Baixa anexo (armazenamento privado, autenticado)', FIN),
  r('delete', '/custos/:id/anexos/:anexoId', 'Custos', 'Remove anexo', FIN, { status: 204 }),

  // ── Financeiro
  rel('/financeiro/dre', 'Financeiro', 'DRE simplificada com metodologia', FIN),
  rel('/financeiro/margem', 'Financeiro', 'Margem operacional', FIN),
  rel('/financeiro/resultado', 'Financeiro', 'Resultado operacional', FIN),
  rel('/financeiro/custos-por-categoria', 'Financeiro', 'Custos por categoria', FIN),
  rel('/financeiro/custos-por-grupo', 'Financeiro', 'Custos por grupo de receita', FIN),
  rel('/financeiro/evolucao', 'Financeiro', 'Evolução mensal', FIN),
  rel('/financeiro/comparativo', 'Financeiro', 'Comparativo com período anterior', FIN),
  r('get', '/financeiro/regras-custo', 'Financeiro', 'Lista regras de custo', FIN),
  r('post', '/financeiro/regras-custo', 'Financeiro', 'Cria regra de custo', FIN, { body: S.regraCustoCriar, status: 201 }),
  r('patch', '/financeiro/regras-custo/:id', 'Financeiro', 'Atualiza regra de custo', FIN, { body: S.regraCustoAtualizar }),

  // ── Classificações
  r('get', '/classificacoes/regras', 'Classificações', 'Lista regras de origem', FIN),
  r('post', '/classificacoes/regras', 'Classificações', 'Cria regra (auditada; reclassifica em segundo plano)', ADM, { body: S.classRegra, status: 201 }),
  r('patch', '/classificacoes/regras/:id', 'Classificações', 'Atualiza regra (versão incrementa)', ADM, { body: S.classPatch }),
  r('delete', '/classificacoes/regras/:id', 'Classificações', 'Remove regra', ADM, { status: 204 }),
  rel('/classificacoes/pendencias', 'Classificações', 'Vendas não classificadas, agregadas'),
  r('post', '/classificacoes/simular', 'Classificações', 'Simula regra contra vendas existentes (somente leitura)', FIN, { body: S.classSimular }),

  // ── Sincronização
  r('get', '/integracoes/sheets/status', 'Integração', 'Estado da integração e atualidade dos dados', TODOS),
  r('get', '/integracoes/sheets/execucoes', 'Integração', 'Histórico de execuções', ADM, { query: S.syncPagina, paginado: true }),
  r('get', '/integracoes/sheets/erros', 'Integração', 'Erros de importação (sanitizados)', ADM, { query: S.syncPagina, paginado: true }),
  r('get', '/integracoes/sheets/fontes', 'Integração', 'Fontes, cabeçalhos reconhecidos e cursores', ADM),
  r('post', '/integracoes/sheets/sincronizar', 'Integração', 'Sincronização incremental manual (202; 409 se já houver uma)', ADM, { body: S.syncBody, status: 202 }),
  r('post', '/integracoes/sheets/reconciliar', 'Integração', 'Reconciliação completa manual (202; 409 se já houver uma)', ADM, { body: S.syncBody, status: 202 }),

  // ── Admin
  r('get', '/admin/auditoria', 'Admin', 'Trilha de auditoria', ADM, { query: S.auditoria, paginado: true }),
  r('get', '/admin/metricas', 'Admin', 'Métricas operacionais', ADM),
];
