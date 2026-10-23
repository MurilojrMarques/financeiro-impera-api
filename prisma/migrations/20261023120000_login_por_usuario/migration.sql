-- Login por e-mail OU nome de usuário: o e-mail deixa de ser obrigatório, desde que exista um usuário.
ALTER TABLE "usuarios" ADD COLUMN "usuario" TEXT;
ALTER TABLE "usuarios" ALTER COLUMN "email" DROP NOT NULL;
CREATE UNIQUE INDEX "usuarios_usuario_key" ON "usuarios"("usuario");
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_email_ou_usuario_chk" CHECK ("email" IS NOT NULL OR "usuario" IS NOT NULL);
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_usuario_formato_chk" CHECK ("usuario" IS NULL OR "usuario" ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
