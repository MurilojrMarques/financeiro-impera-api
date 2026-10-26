# Módulo de RH (colaboradores PJ)

API em `/api/v1/rh`. O sistema de RH antigo (MySQL `impera_rh`, tabela `app_state`) **continua funcionando**: esta API só lê dele.

## Dados
Tabelas no PostgreSQL: `rh_colaboradores`, `rh_movimentacoes` (promoções/reajustes), `rh_faixas_salariais`, `rh_documentos`, `rh_folha_competencias`, `rh_folha_itens`, `rh_usuarios_legado` (sem senhas).
Vagas, avaliações, DISC, eNPS, feedbacks, treinamentos e sucessão **não** fazem parte deste módulo (ficam no sistema antigo).

## Importar do sistema antigo (somente leitura)
Variáveis `RH_*` no `.env` (túnel SSH + MySQL). Comandos:

| Comando | O que faz |
|---|---|
| `npm run rh:explorar` | mostra estrutura e agregados do JSON, sem dados pessoais |
| `npm run rh:importar` | simulação; com `-- --aplicar` grava (repetível: atualiza pelo id do sistema antigo) |
| `npm run rh:usuarios` | simulação; com `-- --aplicar` cria os logins dos colaboradores ativos |

Fotos viram arquivos em `RH_STORAGE_DIR/fotos`. **Faça backup de `RH_STORAGE_DIR`** (fotos, NF, comprovantes).

## Quem vê o quê
O papel de RH (`rhPapel`) é independente do perfil financeiro: a mesma pessoa pode ser `FINANCEIRO` e `RH`. ADMIN/FINANCEIRO **sem** papel de RH não entram. Perfil `SEM_FINANCEIRO` não acessa nenhuma tela do financeiro.

| Papel | Colaboradores | Salário | Escreve | Documentos |
|---|---|---|---|---|
| RH | todos | todos | sim | todos; envia qualquer tipo; aprova/reprova |
| CEO | todos | todos | não | vê e baixa todos |
| GESTOR | a própria equipe (diretos e indiretos), sem salário nem CNPJ/endereço/nascimento; o próprio cadastro completo | só o próprio | não | só os próprios |
| COLABORADOR | só o próprio | o próprio | não | só os próprios; envia a própria NF |

Toda consulta a salário gera auditoria (`rh.salario_consultado`).

## Rotas
- `GET /colaboradores`, `/colaboradores/eu`, `/colaboradores/:id`, `/colaboradores/:id/foto`, `/colaboradores/:id/movimentacoes`
- `GET /colaboradores/painel` (RH/CEO): ativos, folha mensal, por departamento e senioridade, movimentações dos últimos 90 dias
- `POST /colaboradores`, `PATCH /colaboradores/:id` (inclui desligamento, que desativa o login), `DELETE` (só sem histórico) — RH
- `POST /colaboradores/:id/movimentacoes` — promoção/reajuste: grava histórico e atualiza o salário (RH)
- `GET /folha`, `GET /folha/:AAAA-MM` (RH/CEO); `POST /folha/:AAAA-MM/gerar`, `PATCH /folha/:AAAA-MM/itens/:id`, `POST /folha/:AAAA-MM/fechar` (RH)
- `POST /documentos` (multipart, campo `arquivo`), `GET /documentos`, `GET /documentos/:id/arquivo`, `PATCH /documentos/:id/status`

## Folha
O valor pago é o **salário cadastrado** (sem o multiplicador de PJ 1,10 do sistema antigo, decisão de 26/10/2026) + comissão + bônus − desconto, estes três lançados manualmente. O salário do mês vem do histórico de reajustes (setembro mostra o salário de setembro, mesmo que a pessoa tenha sido reajustada depois). Não há proporcional (pro-rata) para quem entra ou sai no meio do mês. Folha fechada só aceita registro de pagamento.
A comissão automática por colaborador (a partir do sistema financeiro) ainda **não** existe.

## Documentos
PDF, PNG, JPG ou WEBP (conferido pelo conteúdo do arquivo), até `RH_DOC_MAX_BYTES` (10 MB). Guardados em `RH_STORAGE_DIR/documentos/<colaborador>/`, nunca no Git. Download sempre como anexo, com `nosniff`.

## Senhas iniciais
Primeiro nome (minúsculas, sem acento) + data de nascimento `DDMMAAAA`; troca obrigatória no primeiro acesso. Contas com papel RH ou CEO recebem senha **aleatória** (arquivo `RH_STORAGE_DIR/credenciais-iniciais.txt`; entregue e apague), porque uma senha previsível ali deixaria um colega assumir a conta que enxerga todos os salários.
