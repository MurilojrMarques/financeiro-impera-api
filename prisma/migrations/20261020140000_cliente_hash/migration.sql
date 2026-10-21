ALTER TABLE "vendas" ADD COLUMN "clienteHash" TEXT;
CREATE INDEX "vendas_clienteHash_idx" ON "vendas"("clienteHash");
