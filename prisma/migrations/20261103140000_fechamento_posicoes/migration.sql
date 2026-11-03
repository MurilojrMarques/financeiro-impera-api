-- CreateTable
CREATE TABLE "fechamento_posicoes" (
    "competencia" TEXT NOT NULL,
    "posicao" TEXT NOT NULL,
    "criadoPorId" UUID,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fechamento_posicoes_pkey" PRIMARY KEY ("competencia")
);
