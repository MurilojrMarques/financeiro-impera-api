-- CreateEnum
CREATE TYPE "TipoTokenUsuario" AS ENUM ('RESET_SENHA', 'CONVITE');

-- AlterTable
ALTER TABLE "usuarios"
  ADD COLUMN "convitePendente" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "falhasLogin" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bloqueadoAte" TIMESTAMPTZ,
  ADD COLUMN "senhaAlteradaEm" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "tokens_usuario" (
  "id" UUID NOT NULL,
  "usuarioId" UUID NOT NULL,
  "tipo" "TipoTokenUsuario" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiraEm" TIMESTAMPTZ NOT NULL,
  "usadoEm" TIMESTAMPTZ,
  "revogadoEm" TIMESTAMPTZ,
  "ip" TEXT,
  "userAgent" TEXT,
  "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tokens_usuario_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "senhas_historico" (
  "id" UUID NOT NULL,
  "usuarioId" UUID NOT NULL,
  "senhaHash" TEXT NOT NULL,
  "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "senhas_historico_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tokens_usuario_tokenHash_key" ON "tokens_usuario"("tokenHash");
CREATE INDEX "tokens_usuario_usuarioId_tipo_usadoEm_revogadoEm_idx" ON "tokens_usuario"("usuarioId", "tipo", "usadoEm", "revogadoEm");
CREATE INDEX "tokens_usuario_criadoEm_idx" ON "tokens_usuario"("criadoEm");
CREATE INDEX "senhas_historico_usuarioId_criadoEm_idx" ON "senhas_historico"("usuarioId", "criadoEm");

-- AddForeignKey
ALTER TABLE "tokens_usuario" ADD CONSTRAINT "tokens_usuario_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "senhas_historico" ADD CONSTRAINT "senhas_historico_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
