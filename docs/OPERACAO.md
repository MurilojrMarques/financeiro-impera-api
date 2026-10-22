# Operação: deploy, backup e diagnóstico

## Deploy em VPS (Docker Compose)

1. Instale Docker + Compose plugin. Clone o repositório e crie o `.env` a partir de `.env.example`:
   - `NODE_ENV` é definido pelo compose como `production`; por isso `CORS_ORIGINS` (origem do dashboard, sem `*`) e `COOKIE_SECURE=true` são **obrigatórios** (a API recusa subir sem eles).
   - `POSTGRES_PASSWORD` forte; `JWT_ACCESS_SECRET` ≥ 32 caracteres aleatórios; `TRUST_PROXY=1` atrás de Nginx/Caddy.
   - `COOKIE_SAMESITE=lax` se dashboard e API estiverem no mesmo site (ex.: `app.empresa.com` e `api.empresa.com`); `none` só se forem sites distintos (exige HTTPS).
2. `mkdir -p secrets` e copie `google-sa.json` (permissão `chmod 600`). Compartilhe a planilha com a Service Account.
3. `docker compose up -d --build`. A ordem é `db` (healthcheck) → `migrate` (one-shot) → `api` + `worker`.
4. Crie o admin: `docker compose run --rm -e BOOTSTRAP_ADMIN_EMAIL=voce@empresa.com api node dist/scripts/bootstrap-admin.js`.
5. TLS: coloque um proxy reverso na frente (Caddy abaixo). Não publique a porta do PostgreSQL.

```caddyfile
api.empresa.com {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
```

Atualização: `git pull && docker compose up -d --build` (as migrations rodam no serviço `migrate` antes da API).

## Usuário PostgreSQL de mínimo privilégio

A aplicação não precisa ser superusuário. Padrão recomendado (dois papéis):

```sql
CREATE ROLE financeiro_migrator LOGIN PASSWORD '...';   -- só para `prisma migrate deploy`
CREATE ROLE financeiro_app LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE financeiro OWNER financeiro_migrator;
\c financeiro
REVOKE ALL ON DATABASE financeiro FROM PUBLIC;
GRANT CONNECT ON DATABASE financeiro TO financeiro_app;
GRANT USAGE ON SCHEMA public TO financeiro_app;
ALTER DEFAULT PRIVILEGES FOR ROLE financeiro_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO financeiro_app;
ALTER DEFAULT PRIVILEGES FOR ROLE financeiro_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO financeiro_app;
```

Use `financeiro_migrator` no serviço `migrate` e `financeiro_app` em `api`/`worker`. O `TRUNCATE` só existe nos testes.

## Backup e restauração

**O que salvar:** o banco PostgreSQL (todas as vendas, regras, usuários, auditoria) e o volume `anexos` (comprovantes de custos).
A planilha Google é a origem, mas **não** é backup: regras de classificação, aliases, custos e usuários só existem no PostgreSQL.

```bash
# backup lógico diário (cron do host), com retenção
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > /backups/financeiro-$(date +%F).dump
docker run --rm -v financeiro-impera-api_anexos:/d -v /backups:/b alpine tar czf /b/anexos-$(date +%F).tgz -C /d .
find /backups -type f -mtime +14 -delete
```

Guarde cópias **fora** da VPS (objeto/S3 criptografado). Teste a restauração periodicamente.

```bash
# restauração (em um banco vazio)
docker compose stop api worker
docker compose exec -T db dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
docker compose exec -T db createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner < /backups/financeiro-AAAA-MM-DD.dump
docker run --rm -v financeiro-impera-api_anexos:/d -v /backups:/b alpine tar xzf /b/anexos-AAAA-MM-DD.tgz -C /d
docker compose up -d
```

Após restaurar, o worker faz a reconciliação diária e converge com a planilha; o hash dos registros evita duplicação.

## Diagnóstico

| Sintoma | Onde olhar | Causa provável |
|---------|-----------|----------------|
| `dadosDesatualizados: true` | `GET /integracoes/sheets/status` | worker parado, Google fora do ar ou credencial inválida |
| estado `CREDENCIAIS_INVALIDAS` | `.../fontes`, logs do worker | JSON da Service Account errado/expirado |
| estado `PLANILHA_INACESSIVEL` | idem | planilha não compartilhada com a Service Account ou `GOOGLE_SHEET_ID` errado |
| estado `ABA_INEXISTENTE` | idem | nome da aba difere de `SHEET_TAB_*` |
| `CABECALHO_OBRIGATORIO_AUSENTE` | idem + mensagem lista as colunas | coluna renomeada; ajuste `SHEET_HEADER_ALIASES_JSON` |
| `PARCIAL` / erros | `GET .../erros` (ADMIN) | linhas com data/valor inválidos (mensagem não contém o valor da célula) |
| `409 SYNC_EM_ANDAMENTO` | `.../execucoes` | já há uma sincronização (lock no PostgreSQL); aguarde |
| `NAO_CLASSIFICADA` alto | `GET /classificacoes/pendencias` | faltam regras de origem; use `POST /classificacoes/simular` |
| API não sobe | log `Configuração de ambiente inválida: ...` | variável obrigatória ausente (mensagem lista quais) |

Logs são JSON (Pino) com `requestId`; `Authorization`, cookies e campos de senha/token são redigidos.
Se um lock ficar preso (processo morto), a conexão cai e o PostgreSQL o libera sozinho — não há lock em tabela para limpar.

## Sincronização automática (a cada 1 hora)
- A **própria API** sincroniza sozinha: a cada `AUTO_SYNC_INTERVAL_MINUTES` (padrão **60**) roda EVENTOS e REDTRACK em modo **incremental**; na subida da API (após `AUTO_SYNC_STARTUP_DELAY_SECONDS`) sincroniza na hora se a última foi há mais que o intervalo (a máquina pode ter ficado desligada); e uma vez por dia (`SYNC_RECONCILE_TIME`, 03:30 de Brasília) faz a **reconciliação completa** das três abas.
- Fontes que nunca sincronizaram fazem a importação INICIAL automaticamente.
- Usa o **mesmo lock** do banco da sincronização manual: nunca roda duas ao mesmo tempo; se a tela "Integrações" (botão **Sincronizar agora**) estiver rodando, o ciclo automático é adiado sem erro.
- "Dados desatualizados" passa a valer só depois de **1,5 × o intervalo** (90 min com 60): `limiteDesatualizadoSegundos` em `/integracoes/sheets/status`.
- Desligar: `AUTO_SYNC_ENABLED=false` (ou `SYNC_ENABLED=false`, chave geral). Se usar o worker separado (`npm run start:worker`), desligue aqui para não duplicar.
- A tela **Integrações** mostra a frequência e a próxima execução; os botões **Sincronizar agora** e **Reconciliação completa** (ADMIN) continuam.
