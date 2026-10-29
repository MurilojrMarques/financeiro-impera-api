-- Reaper (copy) = Cássio Casagrande, desligado em 03/07/2026: ligado ao colaborador do RH para a comissão do Front não ser paga a ele.
-- Sem efeito se o colaborador não existir ou já estiver ligado a outro copywriter.
UPDATE "rh_colaboradores"
   SET "copywriterId" = 'adf0fb13-9eb5-4eb6-8dc5-a2c6085384bd'
 WHERE "nome" = 'Cássio Casagrande'
   AND "copywriterId" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "rh_colaboradores" WHERE "copywriterId" = 'adf0fb13-9eb5-4eb6-8dc5-a2c6085384bd');
