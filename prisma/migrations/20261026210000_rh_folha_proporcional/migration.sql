-- AlterTable
ALTER TABLE "rh_folha_itens" ADD COLUMN     "diasTrabalhados" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "salarioMensalCentavos" INTEGER NOT NULL DEFAULT 0;

UPDATE "rh_folha_itens" SET "salarioMensalCentavos" = "salarioCentavos" WHERE "salarioMensalCentavos" = 0;
