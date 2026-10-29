-- AlterTable
ALTER TABLE "rh_folha_itens" ADD COLUMN     "imperaCredCentavos" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "rh_impera_cred" (
    "id" UUID NOT NULL,
    "colaboradorId" UUID NOT NULL,
    "competencia" TEXT NOT NULL,
    "valorCentavos" INTEGER NOT NULL,
    "observacao" TEXT,
    "criadoPorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rh_impera_cred_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rh_impera_cred_competencia_idx" ON "rh_impera_cred"("competencia");

-- CreateIndex
CREATE INDEX "rh_impera_cred_colaboradorId_competencia_idx" ON "rh_impera_cred"("colaboradorId", "competencia");

-- AddForeignKey
ALTER TABLE "rh_impera_cred" ADD CONSTRAINT "rh_impera_cred_colaboradorId_fkey" FOREIGN KEY ("colaboradorId") REFERENCES "rh_colaboradores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
