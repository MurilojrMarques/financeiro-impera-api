-- CreateEnum
CREATE TYPE "AcaoAjusteFechamento" AS ENUM ('INCLUIR_VENDA', 'EXCLUIR_VENDA');

-- CreateTable
CREATE TABLE "fechamento_ajustes" (
    "id" UUID NOT NULL,
    "competencia" TEXT NOT NULL,
    "pedido" TEXT NOT NULL,
    "acao" "AcaoAjusteFechamento" NOT NULL,
    "motivo" TEXT NOT NULL,
    "criadoPorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fechamento_ajustes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fechamento_ajustes_competencia_pedido_key" ON "fechamento_ajustes"("competencia", "pedido");
