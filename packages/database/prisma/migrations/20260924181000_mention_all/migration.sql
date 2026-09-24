-- ADR-029: opção "marcar todos" por campanha. Só acrescenta uma coluna, desligada por padrão.

-- AlterTable
ALTER TABLE `Campaign` ADD COLUMN `mentionAll` BOOLEAN NOT NULL DEFAULT false;
