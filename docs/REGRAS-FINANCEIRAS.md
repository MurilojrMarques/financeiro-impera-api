# Regras financeiras e metodologia

Este documento descreve **exatamente** como cada métrica é composta e onde a documentação original era
ambígua (marcado como **DECISÃO ABERTA**). Nada ambíguo foi decidido em silêncio: cada caso virou
configuração explícita, estado `NAO_CLASSIFICADA` ou aviso nos relatórios.

## 1. Valores

- Tudo em **centavos inteiros** (`*Centavos`). O parse de texto monetário é feito por string, sem `float`.
- Valor de venda = `valor_sem_juros`. `valor_total` (com juros) é guardado, mas **nunca** entra em faturamento.
- Célula vazia = `null` (ausente). `0` é um valor explícito. Comissão ausente não entra no total e gera alerta.

## 2. Grupos de receita (mutuamente exclusivos)

Precedência aplicada a cada venda, uma única vez, gravando o motivo (`classificacaoMotivo`) e a regra usada:

| # | Critério | Grupo |
|---|----------|-------|
| 1 | campo `afiliado` preenchido | `AFILIADO` |
| 2 | `tipo` = "call center" | `CALL_CENTER` |
| 3 | `RegraClassificacao` ativa que case (menor `prioridade` vence) | grupo da regra (única via para `BACKEND_OUTROS`) |
| 4 | `tipo` = front / upsell / downsell | `FRONT` |
| 5 | nenhum critério confiável | `NAO_CLASSIFICADA` |

Itens 1, 2 e 4 reproduzem o Python existente. O item 3 é novo e existe porque os campos da planilha não bastam
para identificar Back-end (SMS, e-mail, disparos...) — **nenhuma classificação é inferida de nome de produto ou campanha**.

```
receitaGeral = front + backendOutros + callCenter + afiliados + naoClassificadas   (soma de grupos exclusivos)
backendTotal = backendOutros + callCenter                                          (agregado; NUNCA somar de novo)
```

**DECISÃO ABERTA 1 — Back-end Outros.** Cadastre regras em `POST /classificacoes/regras` (campo, operador, valor, grupo,
canal). Teste antes em `POST /classificacoes/simular`. Pendências em `GET /classificacoes/pendencias`.
Uma regra de Back-end vence o tipo `front` (item 3 antes do 4) — isso é intencional: é o que permite “carvar” vendas de
SMS/e-mail que o site marca como `front`. Se preferir o contrário, é uma troca de ordem em `classificacao.service.ts`.

## 3. Critérios financeiros (`modo`)

| Critério | Definição |
|----------|-----------|
| `APROVADAS` | Pedidos **pagos no período** (data do pagamento), valorados pelo **status atual**: `receita = valor_sem_juros − perda atual`. Pedido integralmente estornado/chargeback não conta. Aproxima o painel Pagah. |
| `MOVIMENTACAO` *(padrão)* | `pagamentos do período − perdas reconhecidas na data do evento de perda`. Uma perda em outubro de um pedido pago em setembro reduz outubro. |

Os dois nunca são misturados numa mesma resposta; `meta.criterioFinanceiro` e `meta.metodologia` sempre informam qual foi usado.
Ticket médio: `APROVADAS` = receita ÷ pedidos aprovados; `MOVIMENTACAO` = faturamento bruto ÷ pedidos pagos.

## 4. Estornos e chargebacks (sem contagem em dobro)

- Cada pedido tem **uma** `perdaCentavos` (`perdaTipo`, `perdaEm`).
- Estorno + chargeback integrais do mesmo pedido = **uma** perda e **fica o chargeback** (regra do Elias: a Pagah às vezes envia os dois com segundos de diferença): a perda é atribuída ao chargeback, no dia em que o aviso do chargeback chegou. Os dois eventos permanecem em `venda_eventos` para auditoria.
- Eventos parciais (valor < venda) somam-se (eventos distintos), limitados ao valor da venda; o pedido segue `PAGO`.
- Evento sem valor é tratado como integral **e sinalizado** em `avisos`.
- O `HISTORICO` guarda só o status atual: gera apenas o evento de perda (valor integral, derivado do status) e o
  evento de pagamento **somente se houver data de pagamento**. Nenhum pagamento é fabricado. Isso evita o desconto em
  dobro do código antigo: a perda é um número por pedido, aplicado uma vez.
- Pedido sem data de pagamento fica `PENDENTE_CONCILIACAO` e fora das visões por data (alerta explícito).
- **Reembolsos Pix que não chegam pelo webhook não são conhecidos nem estimados.** Todo relatório de reembolso informa a limitação.

## 5. Comissão

> **VIGENTE (substitui o que está abaixo para a comissão da operação):** a coluna `comissao` da planilha é o valor líquido a receber da Pagah — **não é comissão** e deixou de ser usada. Hoje só existem duas fórmulas: **Call Center = 20% de tudo que ele vende**; **Front = MC BR do RedTrack** — `(Front + Upsell 1 + Downsell 1 + Downsell 2) × 0,70 − custo × 1,10` (revenuetype 2+3+6+7 e `cost`; sem dados da Pagah), exibido na página Front (`/trafego/resumo` → `mcBrCentavos`) (valor da venda, no período e modo do filtro). Para Backend, Recuperação, Afiliado e o total do Dashboard a fórmula **não está definida**: a API devolve 0 e o front mostra "Em implementação". A comissão do afiliado (campo distinto) não foi alterada. O texto abaixo é histórico.

Fonte (`comissaoFonte`) por prioridade — maior substitui menor, igual = o mais recente prevalece (correção):

`HISTORICO_EXATA` > `PAGAH` > `REDTRACK` > `REGRA_AFILIADO` > `ESTIMADA` > `AUSENTE`

- Estimada substituída por confirmada atualiza **a mesma venda** (nenhum registro novo).
- **Comissão do afiliado é um campo distinto** (`comissaoAfiliadoCentavos` + `comissaoAfiliadoFonte`): a da operação é o que a Impera recebe; a do afiliado é o que ele recebe. O valor exato vem da coluna `comissao_afiliado` do HISTORICO; na falta dele vale a `RegraComissaoAfiliado` (valor fixo **ou** percentual, vigência, fonte, auditoria) e o relatório sinaliza como estimada (`COMISSAO_AFILIADO_ESTIMADA`). **Regras por afiliado (decididas em 23/10/2026):** André Pinheiro = R$ 240 fixos por venda; Leonardo = 30% do valor da venda. Na planilha da Pagah os afiliados também aparecem pelo código: `544` = André e `219` = Leonardo (deduzido pela loja e período das vendas; confirmar com a Pagah). **Não existe valor universal**: o R$ 240 do `pagah.py` está cadastrado só para André Pinheiro (`npm run regras:iniciais`). Regras nunca alteram a comissão da operação.
- Comissão da operação, comissão do afiliado e taxa do Call Center são campos distintos e nunca somados entre si.
- **X1** (regra decidida: *Pix sem valor líquido do vendedor 889739*; identificado pelo `id_user_venda` do payload): comissão considerada **0** nos relatórios padrão; o valor real fica guardado e só aparece com `?incluirX1=true`
  para `ADMIN`/`FINANCEIRO`, em listagens/conciliação, e em `x1ComissaoRealCentavos` (informativo, fora dos totais).
  O critério fica em `configuracoes_financeiras` (`x1.criterio`, aceita `{"todas":[...]}` com os campos `LOJA|CHECKOUT|PRODUTO|ORIGEM|TIPO|METODO|VENDEDOR_ID|LIQUIDO`) e é aplicado por `npm run regras:iniciais`. Sem configuração nenhuma venda é X1. Só `id_user_venda` é extraído do payload; o resto do JSON (que contém chaves de dados pessoais) é descartado em memória.
- **Payout do RedTrack = comissão exata** (decidido): substitui comissão **estimada** na mesma venda (`redtrack.payoutComoComissao`, ligado por padrão; `false` desliga). Não sobrescreve valor do histórico nem da Pagah.

## 6. Datas

`America/Sao_Paulo` é o fuso de negócio. Períodos são `[00:00 de, 00:00 do dia seguinte a ate)` nesse fuso.
Datas sem offset da planilha são interpretadas como horário de São Paulo. Original preservado: `pagoEm`, `criadoEmOrigem`,
`recebidoEm` (evento), `ocorridoEm`, `sincronizadoEm`.

Data de estorno/chargeback em EVENTOS = `recebido_em` (o dia em que o aviso chega — regra decidida). No `HISTORICO` usa-se `data_estorno`.

## 7. Unidades

Indisponíveis (a planilha não traz). Regras de custo “por unidade” são reportadas como não calculáveis.

## Decisões abertas

Resumo do que precisa de confirmação do negócio antes de confiar nos números em produção:

| # | Tema | Situação | Como resolver |
|---|------|----------|---------------|
| 1 | Back-end Outros (SMS, e-mail, disparo, pós-venda) | **Aberto.** `origem` do HISTORICO não traz esses valores (só Site, Call, nomes de atendentes). Candidatos em `utm_source`: `SMSFunnel` (SMS?), `activecampaign` (e-mail?) — porém o doc diz que `utm_source` mente | Confirmar e cadastrar regras em `/classificacoes/regras` (simular antes) |
| 2 | X1 | **Resolvido**: Pix + sem líquido + vendedor 889739 | `npm run regras:iniciais` |
| 3 | Payout RedTrack = comissão | **Resolvido**: sim (substitui estimada) | — |
| 4 | Data de estorno/chargeback | **Resolvido**: dia em que o aviso chega | — |
| 5 | Chargeback + estorno do mesmo pedido | **Resolvido**: conta uma vez, como chargeback | — |
| 6 | Comissão/taxa Call Center no resultado | **Aberto**: "comissão é o que a Impera recebe" (receita?); taxa de 20% do Call Center vem em `valor_taxa_callcenter` | Definir a fórmula da "sobra" do Call Center |
| 7 | Atendente do Call Center | **Parcial**: está em `origem` (HISTORICO); EVENTOS só traz `id_user_venda` (id) | Confirmar mapeamento `origem` → atendente e id → nome |
| 8 | Venda Interna (Pedro Carvalho + Matheus Barbosa) | **Aberto**: o painel soma Call Center + Venda Interna; 16 vendas com origem "Matheus Barbosa" têm afiliado preenchido e caem em AFILIADO | Definir a precedência |
| 9 | Afiliados com nome numérico (`544`, `219`; 95 vendas) | **Aberto**: parecem ids, não nomes | Informar o mapa id → nome (aliases) |
| 10 | Loja agrupadora (Erevita inclui Turbogel) | **Aberto** | Definir o mapa de lojas |
| 11 | Unidades vendidas | Indisponíveis | Fornecer fonte confiável |
| 12 | Critério padrão (`modo`) | `MOVIMENTACAO` (exemplo do escopo). O painel Pagah usa `APROVADAS` | Escolher o padrão |
| 13 | "Jessica Teste" em `origem` (132 vendas) | **Aberto** | Dizer se é teste a ignorar |
## 8. Custos e resultado

`resultadoOperacional = receitaLiquida − custos`, onde `custos = lançamentos manuais (vencimento no período; recorrências projetadas e sinalizadas) + regras de custo vigentes`.
Comissões e taxa do Call Center **não** são deduzidas automaticamente (**DECISÃO ABERTA 5**): se forem custo da operação, cadastre regra de custo.
Custos sem grupo ficam em `GERAL` e **não** são rateados entre grupos. Sobra/margem do Call Center só aparecem se houver custos atribuídos a ele.
Custos/resultado são restritos a `FINANCEIRO`/`ADMIN`.

## 9. Tráfego (faturamento Front × investimento × custos) — `GET /trafego/resumo`

Reproduz a tela "Para onde vai o faturamento do tráfego" (Copy/Pulso). Valores em centavos; percentuais em pontos-base.

| Item | Regra |
|------|-------|
| Faturamento | Σ `valor_sem_juros` dos pagamentos do grupo FRONT (compra + upsell + downsell) na janela, **sem descontar estornos** (base do RedTrack) |
| Pedidos | compras iniciais (`tipoVenda = FRONT`) da janela |
| Investimento | RedTrack `/report` (campo `cost`, ofertas com "pagah"), só com `REDTRACK_API_KEY`; sem chave/erro = **indisponível** (ROAS, CPA, sobra e margem não são calculados, nunca zero) |
| ROAS | faturamento ÷ investimento |
| Taxa de cartão, PIS, Cofins, IRPJ, CSLL | % sobre o faturamento (padrão 10 / 0,65 / 3 / 2,14 / 1,18) |
| Frete | R$ 17,90 × **remessas**: compras do mesmo cliente (`cliente_id` do EVENTOS, guardado só como hash) no mesmo dia contam 1 frete; compra sem cliente = 1 remessa (avisado) |
| Custo de produto | unidades (nº no nome do kit: "6 Nervepure", "5 Frascos"; ausente = 1, avisado) × custo unitário (padrão R$ 6,10; nome contendo "gelatina" R$ 9,90) |
| Sobra / Margem | faturamento − (investimento + demais custos); margem = sobra ÷ faturamento (ideal 20%) |

Todos os parâmetros são editáveis em `PUT /trafego/parametros` (FINANCEIRO/ADMIN, auditado).

**Janela do dia.** O RedTrack (base do Copy/Pulso) fecha o "dia" 3h antes da meia-noite de São Paulo. Em 19/10/2026 a janela deslocada de −180 min deu 502 compras / R$ 194.638,56 contra 504 / R$ 194.642,09 do Copy (diferença R$ 3,53, provavelmente pedidos de teste, que a planilha descarta); a meia-noite de SP deu 522 / R$ 202.984,70. O padrão é `janelaDeslocamentoMin = -180`; use 0 para o dia civil de SP. Os demais relatórios continuam no dia civil de SP.

**Fuso do banco.** A sessão do PostgreSQL é fixada em UTC (`options: -c TimeZone=UTC`); com o banco em America/Sao_Paulo o adaptador gravava todo `timestamptz` 3h deslocado. Bancos criados antes dessa correção precisam reimportar as vendas (`TRUNCATE` das tabelas de vendas + `npm run sync:once`).

## 10. Call Center × Back-end (decidido em 20/10/2026, conforme o documento do webhook da Pagah)

- **Call Center = back-end, sempre separado do Front** (e afiliados saem separados dos dois). O `tipo = call center` é o pedido que vem com `id_user_venda` (operador); **inclui a venda interna** (Pedro Carvalho, Matheus Barbosa). O kit `[CALLCENTER]` **não** decide: atendentes de afiliado usam o mesmo checkout, por isso a regra de afiliado vem antes (precedência da seção 2).
- **SMS, e-mail e disparo também são back-end**, mesmo pagos no checkout do site. A planilha não tem um campo de origem para isso (a Pagah foi solicitada em 16/10); o único sinal disponível é `utm_source`.
- **Regras cadastradas** (`BACKEND_OUTROS`, vencem o tipo front/upsell; não afetam call center nem afiliado): `utm_source = SMSFunnel` → canal **SMS** (prioridade 10) e `utm_source = activecampaign` → canal **E-mail** (prioridade 11). Simulação em todas as vendas: 32 + 22 vendas, R$ 7.823,76 + R$ 5.353,82, todas saindo de FRONT.
- **Limites conhecidos:** disparos e pós-venda não têm sinal na planilha e seguem no Front até a Pagah mandar a origem da venda; o documento avisa que o `utm_source` pode mentir (caso do "taboola"), então estas regras são um proxy a validar quando o campo de origem chegar.

## 11. Canais da planilha (colunas `canal`, `subcanal`, `origem_lead` do EVENTOS) — vigente desde 21/10/2026

A aba EVENTOS passou a trazer, desde 30/09 e em toda venda nova, três colunas ao final (Y, Z, AA). **A venda fica com quem fechou**, então o
`canal` é a fonte de verdade do grupo (precedência 0, acima de afiliado, tipo e regras de classificação):

| `canal` (planilha) | Grupo | Definição |
|---|---|---|
| front | `FRONT` | venda do site, com upsell e downsell (`subcanal` = compra, upsell ou downsell) |
| call center | `CALL_CENTER` | venda de operador em que a Pagah cobrou a taxa de 20% do call center, e tudo do IOL (inclusive o link `src iol` no site); `subcanal` = vendedor |
| recuperação de vendas | `RECUPERACAO` (novo) | time interno (Pedro, Edinalva, vendedores internos e CS) que vende sem essa taxa, ou link de vendedor no site (`src` pedro, edinalva ou matheus); `subcanal` = vendedor |
| back end | `BACKEND_OUTROS` | SMS, e-mail marketing e disparo para a base; `subcanal` = SMS, e-mail ou disparo |
| afiliado | `AFILIADO` | coluna `afiliado` preenchida |

- `origem_lead` (SMS, e-mail ou disparo) fica gravado em `vendas.origemLead`: indica o lead de back end que um vendedor fechou. A venda continua no canal do vendedor.
- Linhas **sem** `canal` (HISTORICO de setembro, valores desconhecidos) seguem a precedência anterior da seção 2, inclusive as regras de `utm_source` (SMSFunnel/activecampaign).
- **Back-end consolidado** (indicador agregado, nunca somado de novo) = back end + call center + recuperação.
- Vendedor: `vendas.subcanal` alimenta o "por atendente/vendedor" do Call Center e da Recuperação.
- Dia = `pago_em` nas linhas de pagamento; `teste = sim` é ignorado.

**Conferência de 19/10/2026 (valor sem juros, dia civil de SP):** front 557 / R$ 201.699,72 · call center 144 / R$ 45.898,69 ·
recuperação 14 / R$ 4.957,92 · back end 3 / R$ 590,98 · afiliado 0 — idêntico ao informado pelo time.
