-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "colaboradorId" UUID,
ADD COLUMN     "rhPapel" "RhPapel";

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_colaboradorId_key" ON "usuarios"("colaboradorId");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_colaboradorId_fkey" FOREIGN KEY ("colaboradorId") REFERENCES "rh_colaboradores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

