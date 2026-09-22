-- Papéis SUPER_ADMIN / USER (ADR-016).
-- 1) O antigo OWNER tinha acesso total: vira SUPER_ADMIN (nenhuma conta perde acesso).
-- 2) Qualquer valor inesperado vira USER (o papel com MENOS acesso), para a conversão da
--    coluna nunca falhar nem promover alguém por engano.
-- Só a coluna role muda: senhas, sessões (AuthSession) e disabledAt ficam intactos.
UPDATE `User` SET `role` = 'SUPER_ADMIN' WHERE `role` = 'OWNER';
UPDATE `User` SET `role` = 'USER' WHERE `role` NOT IN ('SUPER_ADMIN', 'USER');

-- AlterTable
ALTER TABLE `User` MODIFY `role` ENUM('SUPER_ADMIN', 'USER') NOT NULL DEFAULT 'USER';
