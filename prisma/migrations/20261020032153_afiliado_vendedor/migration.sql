-- AlterTable
ALTER TABLE "vendas" ADD COLUMN     "comissaoAfiliadoCentavos" INTEGER,
ADD COLUMN     "comissaoAfiliadoFonte" "FonteComissao" NOT NULL DEFAULT 'AUSENTE',
ADD COLUMN     "vendedorId" TEXT;
