-- CreateTable
CREATE TABLE "vendedores_pagah" (
    "vendedorId" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "fonte" TEXT NOT NULL,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vendedores_pagah_pkey" PRIMARY KEY ("vendedorId")
);
