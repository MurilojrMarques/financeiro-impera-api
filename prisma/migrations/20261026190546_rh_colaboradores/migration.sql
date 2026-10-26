-- CreateEnum
CREATE TYPE "RhTipoMovimentacao" AS ENUM ('PROMOCAO', 'REAJUSTE');

-- CreateTable
CREATE TABLE "rh_colaboradores" (
    "id" UUID NOT NULL,
    "legadoId" TEXT,
    "nome" TEXT NOT NULL,
    "email" TEXT,
    "celular" TEXT,
    "nascimento" DATE,
    "cnpj" TEXT,
    "endereco" TEXT,
    "camiseta" TEXT,
    "departamento" TEXT NOT NULL,
    "cargoBase" TEXT,
    "funcao" TEXT,
    "tipoCargo" TEXT,
    "senioridade" TEXT,
    "subnivel" INTEGER,
    "gestorId" UUID,
    "inicio" DATE,
    "demissao" DATE,
    "motivoDemissao" TEXT,
    "contratoObs" TEXT,
    "salarioCentavos" INTEGER NOT NULL,
    "descricao" TEXT,
    "obsCargo" TEXT,
    "discordUserId" TEXT,
    "fotoArquivo" TEXT,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rh_colaboradores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rh_movimentacoes" (
    "id" UUID NOT NULL,
    "legadoId" TEXT,
    "colaboradorId" UUID NOT NULL,
    "tipo" "RhTipoMovimentacao" NOT NULL,
    "data" DATE NOT NULL,
    "cargoAnterior" TEXT,
    "cargoNovo" TEXT,
    "departamentoAnterior" TEXT,
    "departamentoNovo" TEXT,
    "senioridadeAnterior" TEXT,
    "senioridadeNova" TEXT,
    "subnivelAnterior" INTEGER,
    "subnivelNovo" INTEGER,
    "salarioAnteriorCentavos" INTEGER NOT NULL,
    "salarioNovoCentavos" INTEGER NOT NULL,
    "obs" TEXT,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rh_movimentacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rh_faixas_salariais" (
    "id" UUID NOT NULL,
    "departamento" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "nivel" TEXT NOT NULL,
    "valorCentavos" INTEGER NOT NULL,
    "atualizadoEm" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rh_faixas_salariais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rh_usuarios_legado" (
    "id" UUID NOT NULL,
    "legadoId" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "papel" TEXT NOT NULL,
    "departamento" TEXT,
    "colaboradorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rh_usuarios_legado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rh_colaboradores_legadoId_key" ON "rh_colaboradores"("legadoId");

-- CreateIndex
CREATE INDEX "rh_colaboradores_departamento_idx" ON "rh_colaboradores"("departamento");

-- CreateIndex
CREATE INDEX "rh_colaboradores_gestorId_idx" ON "rh_colaboradores"("gestorId");

-- CreateIndex
CREATE INDEX "rh_colaboradores_demissao_idx" ON "rh_colaboradores"("demissao");

-- CreateIndex
CREATE UNIQUE INDEX "rh_movimentacoes_legadoId_key" ON "rh_movimentacoes"("legadoId");

-- CreateIndex
CREATE INDEX "rh_movimentacoes_colaboradorId_data_idx" ON "rh_movimentacoes"("colaboradorId", "data");

-- CreateIndex
CREATE UNIQUE INDEX "rh_faixas_salariais_departamento_cargo_nivel_key" ON "rh_faixas_salariais"("departamento", "cargo", "nivel");

-- CreateIndex
CREATE UNIQUE INDEX "rh_usuarios_legado_legadoId_key" ON "rh_usuarios_legado"("legadoId");

-- AddForeignKey
ALTER TABLE "rh_colaboradores" ADD CONSTRAINT "rh_colaboradores_gestorId_fkey" FOREIGN KEY ("gestorId") REFERENCES "rh_colaboradores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rh_movimentacoes" ADD CONSTRAINT "rh_movimentacoes_colaboradorId_fkey" FOREIGN KEY ("colaboradorId") REFERENCES "rh_colaboradores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
