-- CreateEnum
CREATE TYPE "RhStatusSincronizacao" AS ENUM ('SUCESSO', 'ERRO');

-- CreateEnum
CREATE TYPE "RhTipoAlteracao" AS ENUM ('NOVO_COLABORADOR', 'SALARIO', 'CARGO', 'DEPARTAMENTO', 'GESTOR', 'DESLIGAMENTO', 'MOVIMENTACAO', 'REMOVIDO_DA_ORIGEM');

-- AlterTable
ALTER TABLE "rh_colaboradores" ADD COLUMN     "fotoHash" TEXT;

-- CreateTable
CREATE TABLE "rh_sincronizacoes" (
    "id" UUID NOT NULL,
    "iniciadaEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluidaEm" TIMESTAMPTZ,
    "status" "RhStatusSincronizacao" NOT NULL,
    "gatilho" TEXT NOT NULL,
    "origemAtualizadaEm" TIMESTAMPTZ,
    "origemAtualizadaPor" TEXT,
    "lidos" INTEGER NOT NULL DEFAULT 0,
    "novos" INTEGER NOT NULL DEFAULT 0,
    "atualizados" INTEGER NOT NULL DEFAULT 0,
    "alteracoes" INTEGER NOT NULL DEFAULT 0,
    "inconsistencias" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "detalhes" JSONB,

    CONSTRAINT "rh_sincronizacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rh_alteracoes" (
    "id" UUID NOT NULL,
    "sincronizacaoId" UUID NOT NULL,
    "colaboradorId" UUID,
    "tipo" "RhTipoAlteracao" NOT NULL,
    "campo" TEXT,
    "anterior" TEXT,
    "novo" TEXT,
    "detectadaEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rh_alteracoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rh_sincronizacoes_iniciadaEm_idx" ON "rh_sincronizacoes"("iniciadaEm");

-- CreateIndex
CREATE INDEX "rh_alteracoes_detectadaEm_idx" ON "rh_alteracoes"("detectadaEm");

-- CreateIndex
CREATE INDEX "rh_alteracoes_colaboradorId_detectadaEm_idx" ON "rh_alteracoes"("colaboradorId", "detectadaEm");

-- CreateIndex
CREATE INDEX "rh_alteracoes_tipo_detectadaEm_idx" ON "rh_alteracoes"("tipo", "detectadaEm");

-- AddForeignKey
ALTER TABLE "rh_alteracoes" ADD CONSTRAINT "rh_alteracoes_sincronizacaoId_fkey" FOREIGN KEY ("sincronizacaoId") REFERENCES "rh_sincronizacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

