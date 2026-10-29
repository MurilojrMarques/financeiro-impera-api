-- CreateTable
CREATE TABLE "comissao_vsl" (
    "id" UUID NOT NULL,
    "chave" TEXT NOT NULL,
    "dono" TEXT,
    "editor" TEXT,
    "mesmaVsl" TEXT,
    "fonte" TEXT,
    "atualizadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comissao_vsl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comissao_otimizacoes" (
    "id" UUID NOT NULL,
    "competencia" TEXT NOT NULL,
    "copywriter" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "valorCentavos" INTEGER NOT NULL DEFAULT 50000,
    "criadoPorId" UUID,
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comissao_otimizacoes_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "rh_colaboradores" ADD COLUMN     "comissaoChave" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "comissao_vsl_chave_key" ON "comissao_vsl"("chave");

-- CreateIndex
CREATE INDEX "comissao_otimizacoes_competencia_idx" ON "comissao_otimizacoes"("competencia");

-- CreateIndex
CREATE UNIQUE INDEX "rh_colaboradores_comissaoChave_key" ON "rh_colaboradores"("comissaoChave");

-- Cadastro inicial das VSLs de setembro/2026: dono e editor conferidos na planilha "COMISSÃO VSL - SETEMBRO 2026 - COMPLETA" (palavra do Elias + ClickUp).
INSERT INTO "comissao_vsl" ("id", "chave", "dono", "editor", "mesmaVsl", "fonte") VALUES
  (gen_random_uuid(), 'NE OF04 NERVE PURE', 'YAN', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'EM OF09 GOMA BARIATRICA', 'YAN', 'VINICIUS EDITOR', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'NE OF04 NEUROPURE', 'YAN', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'MM OFC05 NEURO SILENCE', 'ELIAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA OF04 ARTIPURE', 'ELIAS', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA OF03 ARTICURE VSL03', 'ELIAS', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'MM OFC05 NEUROVEX VSL02', 'ELIAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'VS OF02 VIS MEL VSL02', 'ELIAS', 'VINICIUS EDITOR', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA ? ARTICURE VSL03', 'ELIAS', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), '? ? MEMOFORCE VSL01', 'ELIAS', 'FREELA FELIPE', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'MM OFC05 MEMO KARE VSL01', 'ELIAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'VS OF03 VIS GOLD', 'ELIAS', 'VINICIUS EDITOR', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'NE OF04 NERVE PURE MINI-VSL', 'ELIAS', 'GABRIEL', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA OF03 ARTICURE GOTAS MINI-VSL', 'ELIAS', 'FREELANCER', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'VS OF03 VIS GOLD VSL03', 'ELIAS', 'VINICIUS EDITOR', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'ED OF26 EREVITA', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DB OFC09 GLICO DROPS VSL03', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA OF05 NATURION VSL01', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA OF02 ARTICURE', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'NE OF02 NERVE PURE', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'ED OFC32 ?', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA OF05 NATURION VSL02', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DB OFC09 GLICO DROPS', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DB OFC09 INSULVITA VSL01', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DB OFC09 GLICO DROPS VSL01', 'DOUGLAS', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'MM OF03 MEMO KARE', 'CAROL', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'NE SEM LANDING', 'EMPRESA', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DB SEM LANDING', 'EMPRESA', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'DA SEM LANDING', 'EMPRESA', NULL, NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'ED OF31 MAXFIL VSL01', 'VINICIUS', 'VINICIUS EDITOR', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'NE OF05 NEUROCARE', 'VINICIUS', 'PANTOJA', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'MM OF04 MEMO KARE VSL01', 'VINICIUS', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'PT OF04 PROSTASAFE VSL01', 'VINICIUS', 'MINEIRO', NULL, 'Planilha COMISSÃO VSL - SETEMBRO 2026 (Elias 01/10 + ClickUp)'),
  (gen_random_uuid(), 'ED OF28 EREVITA', NULL, NULL, 'ED OF26 EREVITA', 'A landing diz uma coisa e o cadastro da VSL outra: soma na mesma VSL'),
  (gen_random_uuid(), 'MM OF05 NATURION VSL01', NULL, NULL, 'DA OF05 NATURION VSL01', 'A landing diz uma coisa e o cadastro da VSL outra: soma na mesma VSL');

-- Otimizações validadas de setembro/2026 (R$ 500 cada), informadas pela gestão em 29/10/2026: Yan (Erevita OF28 LD15) e Carol (Nerve Pure LD12).
INSERT INTO "comissao_otimizacoes" ("id", "competencia", "copywriter", "descricao", "valorCentavos") VALUES
  (gen_random_uuid(), '2026-09', 'YAN', 'Erevita OF28 LD15', 50000),
  (gen_random_uuid(), '2026-09', 'CAROL', 'Nerve Pure LD12', 50000);
