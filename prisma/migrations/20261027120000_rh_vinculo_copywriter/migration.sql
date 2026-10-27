-- AlterTable
ALTER TABLE "rh_colaboradores" ADD COLUMN     "copywriterId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "rh_colaboradores_copywriterId_key" ON "rh_colaboradores"("copywriterId");
