-- Ajuste de chargeback do fechamento do Call Center: pedido que o Pagah mostra como chargeback (ex.: "em tratamento") e que
-- o webhook ainda não mandou entra no desconto da competência, com o valor sem juros, o motivo e quem decidiu.
ALTER TYPE "AcaoAjusteFechamento" ADD VALUE 'INCLUIR_CHARGEBACK';

ALTER TABLE "fechamento_ajustes" ADD COLUMN "valorCentavos" INTEGER;
