-- CreateEnum
CREATE TYPE "RhPapel" AS ENUM ('RH', 'CEO', 'GESTOR', 'COLABORADOR');

-- CreateEnum
CREATE TYPE "RhTipoDocumento" AS ENUM ('NOTA_FISCAL', 'COMPROVANTE_PAGAMENTO', 'CONTRATO', 'OUTRO');

-- CreateEnum
CREATE TYPE "RhStatusDocumento" AS ENUM ('ENVIADO', 'APROVADO', 'REPROVADO');

-- CreateEnum
CREATE TYPE "RhStatusFolha" AS ENUM ('ABERTA', 'FECHADA');

-- CreateEnum
CREATE TYPE "RhStatusPagamento" AS ENUM ('PENDENTE', 'PAGO');

-- AlterEnum
ALTER TYPE "PerfilUsuario" ADD VALUE 'SEM_FINANCEIRO';

-- CreateTable
CREATE TABLE "rh_documentos" (
    "id" UUID NOT NULL,
    "colaboradorId" UUID NOT NULL,
    "tipo" "RhTipoDocumento" NOT NULL,
    "competencia" TEXT,
    "valorCentavos" INTEGER,
    "descricao" TEXT,
    "arquivoNome" TEXT NOT NULL,
    "arquivoCaminho" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "tamanhoBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "RhStatusDocumento" NOT NULL DEFAULT 'ENVIADO',
    "motivoReprovacao" TEXT,
    "enviadoPorId" UUID,
    "revisadoPorId" UUID,
    "revisadoEm" TIMESTAMPTZ,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rh_documentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rh_folha_competencias" (
    "id" UUID NOT NULL,
    "competencia" TEXT NOT NULL,
    "status" "RhStatusFolha" NOT NULL DEFAULT 'ABERTA',
    "fechadaEm" TIMESTAMPTZ,
    "fechadaPorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rh_folha_competencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rh_folha_itens" (
    "id" UUID NOT NULL,
    "competenciaId" UUID NOT NULL,
    "colaboradorId" UUID NOT NULL,
    "salarioCentavos" INTEGER NOT NULL,
    "comissaoCentavos" INTEGER NOT NULL DEFAULT 0,
    "bonusCentavos" INTEGER NOT NULL DEFAULT 0,
    "descontoCentavos" INTEGER NOT NULL DEFAULT 0,
    "totalCentavos" INTEGER NOT NULL,
    "status" "RhStatusPagamento" NOT NULL DEFAULT 'PENDENTE',
    "pagoEm" DATE,
    "obs" TEXT,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rh_folha_itens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rh_documentos_colaboradorId_competencia_idx" ON "rh_documentos"("colaboradorId", "competencia");

-- CreateIndex
CREATE INDEX "rh_documentos_tipo_status_idx" ON "rh_documentos"("tipo", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rh_folha_competencias_competencia_key" ON "rh_folha_competencias"("competencia");

-- CreateIndex
CREATE INDEX "rh_folha_itens_colaboradorId_idx" ON "rh_folha_itens"("colaboradorId");

-- CreateIndex
CREATE UNIQUE INDEX "rh_folha_itens_competenciaId_colaboradorId_key" ON "rh_folha_itens"("competenciaId", "colaboradorId");

-- AddForeignKey
ALTER TABLE "rh_documentos" ADD CONSTRAINT "rh_documentos_colaboradorId_fkey" FOREIGN KEY ("colaboradorId") REFERENCES "rh_colaboradores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rh_folha_itens" ADD CONSTRAINT "rh_folha_itens_competenciaId_fkey" FOREIGN KEY ("competenciaId") REFERENCES "rh_folha_competencias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rh_folha_itens" ADD CONSTRAINT "rh_folha_itens_colaboradorId_fkey" FOREIGN KEY ("colaboradorId") REFERENCES "rh_colaboradores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
