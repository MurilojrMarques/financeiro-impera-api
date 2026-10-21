# Financeiro Impera API

Backend financeiro (Node.js + Express + TypeScript + PostgreSQL + Prisma) que lê as vendas da planilha Google Sheets
(alimentada pelo webhook Pagah existente), sincroniza com o PostgreSQL e expõe uma API REST para o dashboard React.

```
PAGAH → webhook Python (existente, NÃO alterado) → SQLite → Google Sheets
                                                              │ somente leitura (Service Account)
                                          Worker Node.js  ◄───┘  validação · normalização · deduplicação · classificação · conciliação
                                                │
                                           PostgreSQL ◄── API Express (/api/v1) ◄── Dashboard React
```

O dashboard **nunca** consulta o Google Sheets: tudo vem do PostgreSQL.

## Documentação

| Documento | Conteúdo |
|-----------|----------|
| [docs/REGRAS-FINANCEIRAS.md](docs/REGRAS-FINANCEIRAS.md) | Metodologia exata de cada métrica, classificação, estornos, comissão, X1, **decisões em aberto** |
| [docs/IDENTIDADE.md](docs/IDENTIDADE.md) | Chaves de pedido/evento, deduplicação, sincronização, lock e cursor |
| [docs/OPERACAO.md](docs/OPERACAO.md) | Deploy em VPS, backup/restauração, usuário PostgreSQL de mínimo privilégio, diagnóstico |
| Swagger | `GET /docs` (dev) · `GET /docs/openapi.json` — gerado dos schemas Zod reais |

## Requisitos

- Node.js ≥ 22 e npm
- PostgreSQL ≥ 15 (via Docker Compose **ou** instalado) — para dev sem Docker existe `npm run dev:db`

## Instalação (desenvolvimento)

```bash
npm install                 # também executa `prisma generate`
cp .env.example .env        # preencha DATABASE_URL e JWT_ACCESS_SECRET (veja abaixo)
```

Gere o segredo do JWT:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 1. PostgreSQL

Opção A — Docker: `docker compose up -d db` e use `DATABASE_URL=postgresql://financeiro:SENHA@localhost:5432/financeiro?schema=public`
(publique a porta no compose se for rodar a API fora do Docker).

Opção B — sem Docker (somente desenvolvimento): `npm run dev:db` sobe um PostgreSQL embutido em `.pgdata/`
e imprime a URL (`postgresql://financeiro:dev_only_password@localhost:54329/financeiro`).

### 2. Migrations

```bash
npm run migrate:deploy      # aplica as migrations versionadas em prisma/migrations
```

(`npm run migrate:dev` é para criar novas migrations ao alterar `prisma/schema.prisma`.)

### 3. Google Sheets (somente leitura)

1. No Google Cloud, crie um projeto, ative a **Google Sheets API** e crie uma **Service Account** (sem papéis de projeto).
2. Gere uma chave JSON da conta e salve **fora do Git**, ex.: `secrets/google-sa.json` (a pasta `secrets/` está no `.gitignore`).
3. **Compartilhe a planilha com o e-mail da Service Account** (`...@...iam.gserviceaccount.com`) como **Leitor**.
4. No `.env`:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=./secrets/google-sa.json   # ou GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<json em base64>
   GOOGLE_SHEET_ID=<id na URL da planilha: /spreadsheets/d/<ID>/edit>
   SHEET_TAB_HISTORICO=HISTORICO  SHEET_TAB_EVENTOS=EVENTOS  SHEET_TAB_REDTRACK=REDTRACK
   ```
O escopo usado é apenas `spreadsheets.readonly`. As colunas são lidas pelos **cabeçalhos reais** (não por posição);
se algum cabeçalho tiver nome diferente do esperado, estenda o mapeamento sem mexer no código:
`SHEET_HEADER_ALIASES_JSON='{"HISTORICO":{"atendente":["operador_cc"]}}'` (ver `google-sheets.mapper.ts`).

### 4. Primeiro administrador

Não existe senha padrão. Rode **uma vez**:

```bash
BOOTSTRAP_ADMIN_EMAIL=voce@empresa.com npm run bootstrap:admin
```

Sem `BOOTSTRAP_ADMIN_PASSWORD`, uma senha aleatória é gerada e exibida **uma única vez** no terminal. A conta exige troca de
senha no primeiro login (`PATCH /api/v1/auth/change-password`). O comando recusa-se a rodar se já houver um ADMIN ativo.

### 5. Iniciar

```bash
npm run dev            # API em http://localhost:3000   (Swagger em /docs)
npm run dev:worker     # worker de sincronização (outro terminal)
```

Produção: `npm run build && npm start` (API) e `npm run start:worker` (worker) — ou Docker Compose (abaixo).

### 6. Regras decididas e primeira sincronização

`npm run regras:iniciais` aplica as regras já decididas pelo negócio (payout do RedTrack = comissão, critério X1, comissão fixa do André Pinheiro) — idempotente.
Diagnósticos somente leitura: `npm run check:sheets` (abas/cabeçalhos) e `npm run sync:once` (uma sincronização completa, imprime só contagens).


O worker, ao iniciar: valida PostgreSQL → credenciais → acesso às 3 abas → importação inicial (HISTORICO → EVENTOS → REDTRACK).
Para acompanhar: `GET /api/v1/integracoes/sheets/status` (qualquer perfil) e `/execucoes`, `/erros`, `/fontes` (ADMIN).
Disparo manual (ADMIN): `POST /api/v1/integracoes/sheets/sincronizar` ou `/reconciliar` (202; 409 se já houver uma em andamento).

## Docker Compose

```bash
cp .env.example .env                      # defina POSTGRES_*, JWT_ACCESS_SECRET, CORS_ORIGINS, COOKIE_SECURE=true...
mkdir -p secrets && cp /caminho/google-sa.json secrets/google-sa.json
docker compose up -d --build              # db → migrate (one-shot) → api + worker
docker compose run --rm -e BOOTSTRAP_ADMIN_EMAIL=voce@empresa.com api node dist/scripts/bootstrap-admin.js
```

A imagem não contém credenciais; o JSON do Google é montado somente-leitura em `/run/secrets/google-sa.json`.
Detalhes de VPS, proxy TLS e backup em [docs/OPERACAO.md](docs/OPERACAO.md).

## Testes

```bash
npm run typecheck
npm run test:unit      # rápidos, sem banco
npm test               # unitários + integração + e2e (sobe um PostgreSQL real descartável e aplica as migrations)
```

Usam fixtures sintéticas (sem dados pessoais) e **comparam valores calculados com valores esperados**
(ver `tests/integration/relatorios.int.spec.ts`, cujo cabeçalho documenta a conta feita à mão).
Em CI com PostgreSQL de serviço: `TEST_DATABASE_URL=postgresql://... npm test`.
Os testes nunca leem o `.env` real.

## Mapa de rotas (`/api/v1`)

| Domínio | Rotas | Perfis |
|---------|-------|--------|
| Auth | `login`, `refresh`, `logout`, `logout-all`, `me`, `change-password`, `sessions` | público / autenticado |
| Usuários | CRUD + `status` + `perfil` | ADMIN |
| Dashboard | `resumo` `kpis` `evolucao` `comparativo` `distribuicao-receitas` `receitas-por-grupo` `receitas-por-loja` `indicadores` | LEITURA+ |
| Vendas, Front, Back-end, Call Center, Afiliados, RedTrack, Campanhas, Reembolsos | consultas, resumos, séries, detalhamentos | ANALISTA+ (custos/margem do Call Center: FINANCEIRO+) |
| Custos, Financeiro (DRE, margem, regras de custo) | CRUD de lançamentos, categorias, recorrências, anexos | FINANCEIRO+ |
| Classificações | regras (ADMIN), pendências, simulação | ver Swagger |
| Integração | `status` (LEITURA+), `execucoes` `erros` `fontes` `sincronizar` `reconciliar` | ADMIN |
| Admin | `auditoria`, `metricas` | ADMIN |
| Saúde | `GET /health/live`, `/health/ready` | público (mínimo) |

Filtros padronizados (`de`, `ate`, `loja`, `produto`, `grupo`, `afiliadoId`, `metodo`, `status`, `origem`, `tipo`, `modo`, `page`, `limit`,
`sortBy`, `sortOrder`) valem para todos os endpoints de consulta. Período padrão: mês atual em `America/Sao_Paulo`; máximo 366 dias.
Toda resposta financeira informa `meta.criterioFinanceiro` e `meta.ultimaSincronizacao` / `meta.dadosDesatualizados`.

## Arquitetura

```
src/
  config/        env (Zod, falha rápida), logger (Pino + redaction), database (Prisma + pg), google, cors
  middlewares/   auth, authorization (RBAC central), validate (Zod), rate-limit, csrf, error, request-id
  integrations/google-sheets/   client (retry/backoff/jitter) · service (validação de abas/cabeçalhos) · mapper · schemas (Zod)
  modules/       auth, usuarios, dashboard, vendas (+domain/), front, backend, call-center, afiliados, redtrack, reembolsos,
                 custos, financeiro, classificacoes, sincronizacao, admin, health
  shared/        errors, utils (dinheiro em centavos, datas SP, retry), repositories/ledger (SQL de métricas), services
  jobs/ + worker.ts   scheduler, jobs de sync/reconciliação (processo separado da API, mesmo código de domínio)
  docs/          registry + openapi (gerados dos schemas Zod)
```

- **Lógica de domínio pura e testada**: `modules/vendas/domain/*` (perda, comissão, agregação), `classificacoes/classificacao.service.ts`.
- **Uma fonte de métricas**: `shared/repositories/ledger.repository.ts` — todos os módulos usam o mesmo ledger, então regras financeiras não são duplicadas.
- Módulos de leitura simples usam `routes` + helpers de relatório; módulos com mutação (auth, usuários, custos...) têm schema/service/controller.

## Segurança (resumo)

Argon2id · JWT curto (HS256, iss/aud/exp validados, sessão e usuário conferidos no banco a cada request) · refresh token opaco, só o **hash** no
banco, rotacionado a cada uso com detecção de reuso (revoga a sessão) · cookie `HttpOnly` + `SameSite` + CSRF double-submit · RBAC centralizado ·
Zod em todos os parâmetros · SQL parametrizado e ordenação por whitelist · Helmet · CORS por lista explícita (produção recusa `*`) ·
rate limit (global, login, refresh/troca de senha, disparo de sync) · uploads com MIME real, limite de tamanho e armazenamento privado ·
logs com redaction e mensagens de erro de integração sanitizadas · nenhum dado pessoal de comprador é armazenado ou exposto
(`cliente_id`, payload e assinatura do webhook são descartados na leitura) · Swagger fechado em produção (exige ADMIN) · graceful shutdown.

Limites conhecidos: o rate limit usa memória do processo (para várias instâncias da API use um store compartilhado); sem Redis por decisão do escopo.

## Decisões em aberto

A documentação recebida não define alguns pontos. Nenhum foi "inventado" — cada um virou configuração explícita ou estado sinalizado.
Lista completa e como configurar cada um em [docs/REGRAS-FINANCEIRAS.md](docs/REGRAS-FINANCEIRAS.md#decisões-abertas) (Back-end Outros, critério X1,
payout RedTrack, data de estorno em EVENTOS, comissão/taxa no resultado, valores reais dos cabeçalhos do HISTORICO).
