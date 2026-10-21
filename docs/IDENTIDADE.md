# Identidade, deduplicação e sincronização

## Chaves

| Entidade | Chave | Observação |
|----------|-------|------------|
| Venda | `pedido` (único) | identificador externo estável + `id` UUID interno |
| Evento | `eventKey` (único) | determinística, abaixo |
| RegistroImportado | `(fonte, chave)` + `hash` | idempotência por linha |
| Redtrack | `pedido` | relacionamento Pagah × RedTrack |

**`eventKey`** não depende da posição da linha nem do horário de recebimento:

- `PAGAMENTO`: `pedido|PAGAMENTO`
- `ESTORNO` / `CHARGEBACK`: `pedido|TIPO|INTEGRAL` (valor ≥ venda ou ausente) **ou** `pedido|TIPO|<valor em centavos>` (parcial)

Consequências:
- Reenvio do mesmo webhook (outro `recebido_em`, outra linha) **não** duplica o evento.
- O mesmo estorno visto em `HISTORICO` e `EVENTOS` vira **um** evento; `HISTORICO` manda nos dados, `EVENTOS` só completa lacunas.
- Um pedido pode ter pagamento, estorno e chargeback (3 eventos, 1 venda, 1 perda).

**Limite conhecido:** dois reembolsos *parciais* distintos com **exatamente o mesmo valor** no mesmo pedido colapsam em um
(a planilha não traz ID de evento). Se a Pagah passar a enviar um ID de evento, basta incluí-lo na chave.

## Sincronização

- `EVENTOS` a cada 60 s, `REDTRACK` a cada 30 min, `HISTORICO` na primeira execução; reconciliação completa diária (`SYNC_RECONCILE_TIME`).
- Leitura em lotes (`SHEETS_BATCH_SIZE`). Incremental relê `SYNC_LOOKBACK_ROWS` linhas **antes** do cursor para pegar comissões corrigidas.
  O **hash** do registro decide se algo mudou; idênticos são ignorados. Mudança de cabeçalho força releitura completa.
- **Cursor** = última linha de dados persistida, avançado **na mesma transação** que grava o lote. Falha no meio do lote ⇒ rollback do lote e cursor intacto.
- Lock: `pg_try_advisory_lock` em conexão dedicada (vale entre instâncias; solta se o processo morrer). Segunda sincronização simultânea ⇒ `409 SYNC_EM_ANDAMENTO` (manual) ou adiada (worker).
- Falha do Google nunca apaga dados: o estado da fonte vira erro (`CREDENCIAIS_INVALIDAS`, `ABA_INEXISTENTE`, `INDISPONIVEL`...) com mensagem sanitizada, os dados antigos continuam servidos e `meta.dadosDesatualizados` avisa o dashboard.
- Retentativas: backoff exponencial com *full jitter* para 429/5xx/rede/timeout.
