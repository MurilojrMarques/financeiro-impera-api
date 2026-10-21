# Contas de usuário, recuperação de senha e segurança

## Fluxos
| Fluxo | Rotas | Resumo |
|---|---|---|
| Login | `POST /auth/login` | argon2id; resposta idêntica para e-mail inexistente, senha errada, conta inativa, convite pendente e conta bloqueada |
| Esqueci minha senha | `POST /auth/forgot-password` → e-mail → `POST /auth/reset-password` | link de uso único (30 min); resposta **202 sempre igual**; encerra todas as sessões |
| Convite de usuário | `POST /usuarios` (ADMIN) → e-mail → `POST /auth/activate` | o admin **nunca conhece a senha**; link de 72 h; reenvio invalida o anterior |
| Redefinição pelo admin | `POST /usuarios/:id/redefinir-senha` | envia ao usuário o link; o admin não vê nem define a senha |
| Troca logado | `PATCH /auth/change-password` | exige a senha atual, política + histórico, encerra as outras sessões, avisa por e-mail |
| Bloqueio por tentativas | automático | 5 falhas seguidas → 15 min bloqueada (mesma resposta 401), aviso ao titular; admin: `POST /usuarios/:id/desbloquear` |
| Sessões | `GET/DELETE /auth/sessions`, `POST /auth/logout-all` | refresh token rotativo com detecção de reuso |

## Controles de segurança
- **Tokens**: 256 bits aleatórios; só o **hash SHA-256** vai ao banco (`tokens_usuario`); uso único (compare-and-swap atômico); expiram; um novo pedido revoga o anterior; desativar ou trocar o e-mail da conta revoga os pendentes; o tipo importa (convite ≠ redefinição).
- **Link no fragmento** (`/redefinir-senha#token=…`): não vai para logs de acesso nem para o cabeçalho `Referer`; o frontend lê e apaga o token do endereço.
- **Anti-enumeração**: `forgot-password` responde igual e demora no mínimo 300 ms exista ou não a conta; e-mail enviado em segundo plano; link inválido/expirado/usado devolve a mesma mensagem.
- **Limites**: por IP (`forgot` 5/15 min, links 20/15 min, login configurável) e por conta (`FORGOT_PASSWORD_MAX_PER_HOUR`).
- **Política de senha** (NIST 800-63B/OWASP): 12–256 caracteres, letras e números, sem conter nome/e-mail, sem senha comum, sequência ou repetição; **não reaproveita as últimas 5** (`senhas_historico`). A senha é validada **antes** de consumir o link (erro de digitação não queima o link).
- **Senha só em argon2id**; o corpo da requisição nunca é registrado; a auditoria redige campos `senha`/`token`/`hash`.
- **Auditoria**: `auth.reset_solicitado`, `auth.reset_concluido`, `auth.convite_aceito`, `auth.conta_bloqueada`, `auth.login_bloqueado`, `usuario.convite_reenviado`, `usuario.redefinicao_enviada`, `usuario.desbloqueado`, etc.
- **E-mails**: HTML escapado; versão em texto; STARTTLS obrigatório (TLS ≥ 1.2); falha de envio nunca vaza se a conta existe. Em **produção só SMTP** é aceito (o transporte `log` imprime o link e só existe em desenvolvimento).

## Configuração de e-mail
Ver `.env.production.example`. Sem SMTP em produção: `GET /auth/config` devolve `recuperacaoSenha:false` (a tela esconde "Esqueci minha senha"),
`POST /usuarios` sem senha responde 503 e o painel passa a criar usuários com senha temporária (troca obrigatória no primeiro acesso).

## Não incluído (próximos passos recomendados)
Autenticação de dois fatores (TOTP/WebAuthn), SSO (SAML/OIDC), verificação de troca de e-mail, política de expiração periódica de senha e alerta de novo dispositivo.
