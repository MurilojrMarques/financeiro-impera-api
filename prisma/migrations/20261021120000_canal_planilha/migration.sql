ALTER TYPE "TipoGrupo" ADD VALUE IF NOT EXISTS 'RECUPERACAO';
ALTER TABLE "vendas" ADD COLUMN "canalPlanilha" TEXT, ADD COLUMN "subcanal" TEXT, ADD COLUMN "origemLead" TEXT;
CREATE INDEX "vendas_canalPlanilha_idx" ON "vendas"("canalPlanilha");
