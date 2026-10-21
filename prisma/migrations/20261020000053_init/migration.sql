-- CreateEnum
CREATE TYPE "TipoGrupo" AS ENUM ('FRONT', 'BACKEND_OUTROS', 'CALL_CENTER', 'AFILIADO', 'NAO_CLASSIFICADA');

-- CreateEnum
CREATE TYPE "StatusVenda" AS ENUM ('PAGO', 'ESTORNADO', 'CHARGEBACK', 'PENDENTE_CONCILIACAO');

-- CreateEnum
CREATE TYPE "TipoVenda" AS ENUM ('FRONT', 'UPSELL', 'DOWNSELL', 'CALL_CENTER', 'OUTRO');

-- CreateEnum
CREATE TYPE "TipoEvento" AS ENUM ('PAGAMENTO', 'ESTORNO', 'CHARGEBACK');

-- CreateEnum
CREATE TYPE "FonteComissao" AS ENUM ('HISTORICO_EXATA', 'PAGAH', 'ESTIMADA', 'REDTRACK', 'REGRA_AFILIADO', 'AUSENTE');

-- CreateEnum
CREATE TYPE "FonteDadoTipo" AS ENUM ('HISTORICO', 'EVENTOS', 'REDTRACK');

-- CreateEnum
CREATE TYPE "PerfilUsuario" AS ENUM ('ADMIN', 'FINANCEIRO', 'ANALISTA', 'LEITURA');

-- CreateEnum
CREATE TYPE "StatusSincronizacao" AS ENUM ('EXECUTANDO', 'SUCESSO', 'PARCIAL', 'FALHA');

-- CreateEnum
CREATE TYPE "StatusPagamentoCusto" AS ENUM ('PENDENTE', 'PAGO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "PeriodicidadeCusto" AS ENUM ('SEMANAL', 'MENSAL', 'TRIMESTRAL', 'ANUAL');

-- CreateEnum
CREATE TYPE "TipoRegraCusto" AS ENUM ('PERCENTUAL_RECEITA', 'VALOR_POR_PEDIDO', 'VALOR_POR_UNIDADE', 'VALOR_FIXO_PERIODO');

-- CreateEnum
CREATE TYPE "CampoClassificacao" AS ENUM ('ORIGEM', 'TIPO_ATENDIMENTO', 'LOJA', 'CAMPANHA', 'UTM_SOURCE', 'SRC', 'CHECKOUT');

-- CreateEnum
CREATE TYPE "OperadorClassificacao" AS ENUM ('IGUAL', 'CONTEM', 'COMECA_COM');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "perfil" "PerfilUsuario" NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "trocaSenhaObrig" BOOLEAN NOT NULL DEFAULT false,
    "ultimoLoginEm" TIMESTAMPTZ,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessoes" (
    "id" UUID NOT NULL,
    "usuarioId" UUID NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "refreshAnterior" TEXT,
    "expiraEm" TIMESTAMPTZ NOT NULL,
    "revogadaEm" TIMESTAMPTZ,
    "ip" TEXT,
    "userAgent" TEXT,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoUsoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auditoria" (
    "id" UUID NOT NULL,
    "usuarioId" UUID,
    "acao" TEXT NOT NULL,
    "entidade" TEXT,
    "entidadeId" TEXT,
    "detalhes" JSONB,
    "ip" TEXT,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fontes_dados" (
    "id" UUID NOT NULL,
    "tipo" "FonteDadoTipo" NOT NULL,
    "nomeAba" TEXT NOT NULL,
    "cabecalhos" JSONB,
    "cabecalhosAusentes" JSONB,
    "intervaloSegundos" INTEGER NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "ultimaLeituraEm" TIMESTAMPTZ,
    "ultimoSucessoEm" TIMESTAMPTZ,
    "estado" TEXT NOT NULL DEFAULT 'NUNCA_SINCRONIZADA',
    "ultimoErro" TEXT,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fontes_dados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sincronizacoes" (
    "id" UUID NOT NULL,
    "fonte" "FonteDadoTipo" NOT NULL,
    "modo" TEXT NOT NULL,
    "status" "StatusSincronizacao" NOT NULL DEFAULT 'EXECUTANDO',
    "iniciadaEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadaEm" TIMESTAMPTZ,
    "duracaoMs" INTEGER,
    "lidos" INTEGER NOT NULL DEFAULT 0,
    "inseridos" INTEGER NOT NULL DEFAULT 0,
    "atualizados" INTEGER NOT NULL DEFAULT 0,
    "ignorados" INTEGER NOT NULL DEFAULT 0,
    "comErro" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "disparadaPor" TEXT NOT NULL DEFAULT 'worker',

    CONSTRAINT "sincronizacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sincronizacao_cursor" (
    "fonte" "FonteDadoTipo" NOT NULL,
    "ultimaLinha" INTEGER NOT NULL DEFAULT 0,
    "assinaturaCab" TEXT,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sincronizacao_cursor_pkey" PRIMARY KEY ("fonte")
);

-- CreateTable
CREATE TABLE "registros_importados" (
    "id" UUID NOT NULL,
    "fonte" "FonteDadoTipo" NOT NULL,
    "chave" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "linhaOrigem" INTEGER NOT NULL,
    "importadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "registros_importados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erros_importacao" (
    "id" UUID NOT NULL,
    "sincronizacaoId" UUID,
    "fonte" "FonteDadoTipo" NOT NULL,
    "linhaOrigem" INTEGER,
    "codigo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "campo" TEXT,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erros_importacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lojas" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,

    CONSTRAINT "lojas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "produtos" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "downsell" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "produtos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "afiliados" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "nomeBusca" TEXT NOT NULL,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "afiliados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "afiliado_aliases" (
    "id" UUID NOT NULL,
    "afiliadoId" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasBusca" TEXT NOT NULL,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "afiliado_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regras_comissao_afiliado" (
    "id" UUID NOT NULL,
    "afiliadoId" UUID NOT NULL,
    "valorFixoCentavos" INTEGER,
    "percentualBps" INTEGER,
    "vigenteDe" TIMESTAMPTZ NOT NULL,
    "vigenteAte" TIMESTAMPTZ,
    "fonte" TEXT NOT NULL,
    "observacao" TEXT,
    "criadoPorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regras_comissao_afiliado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regras_classificacao" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "campo" "CampoClassificacao" NOT NULL,
    "operador" "OperadorClassificacao" NOT NULL,
    "valor" TEXT NOT NULL,
    "grupo" "TipoGrupo" NOT NULL,
    "canal" TEXT,
    "prioridade" INTEGER NOT NULL DEFAULT 100,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "versao" INTEGER NOT NULL DEFAULT 1,
    "criadoPorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "regras_classificacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendas" (
    "id" UUID NOT NULL,
    "pedido" TEXT NOT NULL,
    "lojaId" UUID,
    "produtoId" UUID,
    "afiliadoId" UUID,
    "afiliadoNomeOriginal" TEXT,
    "grupo" "TipoGrupo" NOT NULL,
    "tipoVenda" "TipoVenda" NOT NULL,
    "tipoBruto" TEXT,
    "status" "StatusVenda" NOT NULL,
    "origem" TEXT,
    "tipoAtendimento" TEXT,
    "atendente" TEXT,
    "checkout" TEXT,
    "kitNome" TEXT,
    "metodoPagamento" TEXT,
    "parcelas" INTEGER,
    "valorTotalCentavos" INTEGER,
    "valorVendaCentavos" INTEGER NOT NULL,
    "jurosCentavos" INTEGER,
    "valorLiquidoCentavos" INTEGER,
    "comissaoCentavos" INTEGER,
    "comissaoFonte" "FonteComissao" NOT NULL DEFAULT 'AUSENTE',
    "taxaCallCenterCentavos" INTEGER,
    "x1" BOOLEAN NOT NULL DEFAULT false,
    "campanha" TEXT,
    "anuncio" TEXT,
    "clickId" TEXT,
    "utmSource" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "src" TEXT,
    "pagoEm" TIMESTAMPTZ,
    "criadoEmOrigem" TIMESTAMPTZ,
    "estornadoEm" TIMESTAMPTZ,
    "chargebackEm" TIMESTAMPTZ,
    "perdaCentavos" INTEGER NOT NULL DEFAULT 0,
    "perdaEm" TIMESTAMPTZ,
    "perdaTipo" "TipoEvento",
    "classificacaoMotivo" TEXT,
    "classificacaoRegraId" UUID,
    "avisos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fonteVerdade" "FonteDadoTipo" NOT NULL,
    "redtrackConciliado" BOOLEAN NOT NULL DEFAULT false,
    "hashConteudo" TEXT NOT NULL,
    "sincronizadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vendas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venda_eventos" (
    "id" UUID NOT NULL,
    "vendaId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "tipo" "TipoEvento" NOT NULL,
    "fonte" "FonteDadoTipo" NOT NULL,
    "ocorridoEm" TIMESTAMPTZ,
    "recebidoEm" TIMESTAMPTZ,
    "valorCentavos" INTEGER,
    "comissaoCentavos" INTEGER,
    "linhaOrigem" INTEGER,
    "hashConteudo" TEXT NOT NULL,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venda_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venda_produtos" (
    "id" UUID NOT NULL,
    "vendaId" UUID NOT NULL,
    "produtoId" UUID NOT NULL,
    "quantidade" INTEGER,

    CONSTRAINT "venda_produtos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redtrack_conversoes" (
    "id" UUID NOT NULL,
    "pedido" TEXT NOT NULL,
    "vendaId" UUID,
    "conversaoId" TEXT,
    "payoutCentavos" INTEGER,
    "situacao" TEXT,
    "campanha" TEXT,
    "anuncio" TEXT,
    "hashConteudo" TEXT NOT NULL,
    "linhaOrigem" INTEGER,
    "sincronizadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redtrack_conversoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias_custo" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categorias_custo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recorrencias_custo" (
    "id" UUID NOT NULL,
    "periodicidade" "PeriodicidadeCusto" NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE,

    CONSTRAINT "recorrencias_custo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custos_operacionais" (
    "id" UUID NOT NULL,
    "descricao" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "categoriaId" UUID NOT NULL,
    "recorrenciaId" UUID,
    "grupo" "TipoGrupo",
    "valorCentavos" INTEGER NOT NULL,
    "vencimento" DATE NOT NULL,
    "statusPagamento" "StatusPagamentoCusto" NOT NULL DEFAULT 'PENDENTE',
    "observacao" TEXT,
    "responsavelId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "custos_operacionais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anexos_custo" (
    "id" UUID NOT NULL,
    "custoId" UUID NOT NULL,
    "nomeOriginal" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "tamanhoBytes" INTEGER NOT NULL,
    "caminho" TEXT NOT NULL,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anexos_custo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regras_custo" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "TipoRegraCusto" NOT NULL,
    "grupo" "TipoGrupo",
    "categoriaId" UUID,
    "valorCentavos" INTEGER,
    "percentualBps" INTEGER,
    "vigenteDe" TIMESTAMPTZ NOT NULL,
    "vigenteAte" TIMESTAMPTZ,
    "metodologia" TEXT NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "regras_custo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracoes_financeiras" (
    "chave" TEXT NOT NULL,
    "valor" JSONB NOT NULL,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "configuracoes_financeiras_pkey" PRIMARY KEY ("chave")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessoes_refreshHash_key" ON "sessoes"("refreshHash");

-- CreateIndex
CREATE INDEX "sessoes_usuarioId_revogadaEm_idx" ON "sessoes"("usuarioId", "revogadaEm");

-- CreateIndex
CREATE INDEX "sessoes_refreshAnterior_idx" ON "sessoes"("refreshAnterior");

-- CreateIndex
CREATE INDEX "auditoria_criadoEm_idx" ON "auditoria"("criadoEm");

-- CreateIndex
CREATE INDEX "auditoria_usuarioId_idx" ON "auditoria"("usuarioId");

-- CreateIndex
CREATE INDEX "auditoria_acao_idx" ON "auditoria"("acao");

-- CreateIndex
CREATE UNIQUE INDEX "fontes_dados_tipo_key" ON "fontes_dados"("tipo");

-- CreateIndex
CREATE INDEX "sincronizacoes_fonte_iniciadaEm_idx" ON "sincronizacoes"("fonte", "iniciadaEm");

-- CreateIndex
CREATE INDEX "sincronizacoes_status_idx" ON "sincronizacoes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "registros_importados_fonte_chave_key" ON "registros_importados"("fonte", "chave");

-- CreateIndex
CREATE INDEX "erros_importacao_fonte_criadoEm_idx" ON "erros_importacao"("fonte", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "lojas_nome_key" ON "lojas"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "produtos_nome_key" ON "produtos"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "afiliados_nomeBusca_key" ON "afiliados"("nomeBusca");

-- CreateIndex
CREATE UNIQUE INDEX "afiliado_aliases_aliasBusca_key" ON "afiliado_aliases"("aliasBusca");

-- CreateIndex
CREATE INDEX "afiliado_aliases_afiliadoId_idx" ON "afiliado_aliases"("afiliadoId");

-- CreateIndex
CREATE INDEX "regras_comissao_afiliado_afiliadoId_vigenteDe_idx" ON "regras_comissao_afiliado"("afiliadoId", "vigenteDe");

-- CreateIndex
CREATE INDEX "regras_classificacao_ativa_prioridade_idx" ON "regras_classificacao"("ativa", "prioridade");

-- CreateIndex
CREATE UNIQUE INDEX "vendas_pedido_key" ON "vendas"("pedido");

-- CreateIndex
CREATE INDEX "vendas_status_idx" ON "vendas"("status");

-- CreateIndex
CREATE INDEX "vendas_pagoEm_idx" ON "vendas"("pagoEm");

-- CreateIndex
CREATE INDEX "vendas_estornadoEm_idx" ON "vendas"("estornadoEm");

-- CreateIndex
CREATE INDEX "vendas_chargebackEm_idx" ON "vendas"("chargebackEm");

-- CreateIndex
CREATE INDEX "vendas_lojaId_idx" ON "vendas"("lojaId");

-- CreateIndex
CREATE INDEX "vendas_afiliadoId_idx" ON "vendas"("afiliadoId");

-- CreateIndex
CREATE INDEX "vendas_grupo_idx" ON "vendas"("grupo");

-- CreateIndex
CREATE INDEX "vendas_origem_idx" ON "vendas"("origem");

-- CreateIndex
CREATE INDEX "vendas_metodoPagamento_idx" ON "vendas"("metodoPagamento");

-- CreateIndex
CREATE INDEX "vendas_campanha_idx" ON "vendas"("campanha");

-- CreateIndex
CREATE INDEX "vendas_sincronizadoEm_idx" ON "vendas"("sincronizadoEm");

-- CreateIndex
CREATE INDEX "vendas_grupo_pagoEm_idx" ON "vendas"("grupo", "pagoEm");

-- CreateIndex
CREATE INDEX "vendas_perdaEm_idx" ON "vendas"("perdaEm");

-- CreateIndex
CREATE UNIQUE INDEX "venda_eventos_eventKey_key" ON "venda_eventos"("eventKey");

-- CreateIndex
CREATE INDEX "venda_eventos_vendaId_idx" ON "venda_eventos"("vendaId");

-- CreateIndex
CREATE INDEX "venda_eventos_tipo_ocorridoEm_idx" ON "venda_eventos"("tipo", "ocorridoEm");

-- CreateIndex
CREATE UNIQUE INDEX "venda_produtos_vendaId_produtoId_key" ON "venda_produtos"("vendaId", "produtoId");

-- CreateIndex
CREATE UNIQUE INDEX "redtrack_conversoes_pedido_key" ON "redtrack_conversoes"("pedido");

-- CreateIndex
CREATE UNIQUE INDEX "redtrack_conversoes_vendaId_key" ON "redtrack_conversoes"("vendaId");

-- CreateIndex
CREATE INDEX "redtrack_conversoes_campanha_idx" ON "redtrack_conversoes"("campanha");

-- CreateIndex
CREATE INDEX "redtrack_conversoes_situacao_idx" ON "redtrack_conversoes"("situacao");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_custo_nome_key" ON "categorias_custo"("nome");

-- CreateIndex
CREATE INDEX "custos_operacionais_vencimento_idx" ON "custos_operacionais"("vencimento");

-- CreateIndex
CREATE INDEX "custos_operacionais_categoriaId_idx" ON "custos_operacionais"("categoriaId");

-- CreateIndex
CREATE INDEX "custos_operacionais_grupo_idx" ON "custos_operacionais"("grupo");

-- CreateIndex
CREATE INDEX "anexos_custo_custoId_idx" ON "anexos_custo"("custoId");

-- CreateIndex
CREATE INDEX "regras_custo_ativa_vigenteDe_idx" ON "regras_custo"("ativa", "vigenteDe");

-- AddForeignKey
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erros_importacao" ADD CONSTRAINT "erros_importacao_sincronizacaoId_fkey" FOREIGN KEY ("sincronizacaoId") REFERENCES "sincronizacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "afiliado_aliases" ADD CONSTRAINT "afiliado_aliases_afiliadoId_fkey" FOREIGN KEY ("afiliadoId") REFERENCES "afiliados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_comissao_afiliado" ADD CONSTRAINT "regras_comissao_afiliado_afiliadoId_fkey" FOREIGN KEY ("afiliadoId") REFERENCES "afiliados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_lojaId_fkey" FOREIGN KEY ("lojaId") REFERENCES "lojas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "produtos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_afiliadoId_fkey" FOREIGN KEY ("afiliadoId") REFERENCES "afiliados"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venda_eventos" ADD CONSTRAINT "venda_eventos_vendaId_fkey" FOREIGN KEY ("vendaId") REFERENCES "vendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venda_produtos" ADD CONSTRAINT "venda_produtos_vendaId_fkey" FOREIGN KEY ("vendaId") REFERENCES "vendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venda_produtos" ADD CONSTRAINT "venda_produtos_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "produtos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redtrack_conversoes" ADD CONSTRAINT "redtrack_conversoes_vendaId_fkey" FOREIGN KEY ("vendaId") REFERENCES "vendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custos_operacionais" ADD CONSTRAINT "custos_operacionais_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "categorias_custo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custos_operacionais" ADD CONSTRAINT "custos_operacionais_recorrenciaId_fkey" FOREIGN KEY ("recorrenciaId") REFERENCES "recorrencias_custo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custos_operacionais" ADD CONSTRAINT "custos_operacionais_responsavelId_fkey" FOREIGN KEY ("responsavelId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anexos_custo" ADD CONSTRAINT "anexos_custo_custoId_fkey" FOREIGN KEY ("custoId") REFERENCES "custos_operacionais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_custo" ADD CONSTRAINT "regras_custo_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "categorias_custo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
