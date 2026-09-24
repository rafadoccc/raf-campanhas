-- Fase 4D (ADR-022): o recibo pendente passa a registrar o DONO da conexão que o recebeu,
-- para um recibo de um usuário nunca casar com o envio de outro.
--
-- Só acrescenta uma coluna opcional e um índice. Nenhum recibo é apagado e nada é alterado:
-- as linhas que já existem ficam com `ownerId` nulo, que significa "veio da sessão global
-- legada". Elas continuam sendo processadas por essa mesma sessão, como hoje. Não há backfill
-- por suposição: atribuir dono a recibos antigos seria adivinhar.

-- AlterTable
ALTER TABLE `PendingRead` ADD COLUMN `ownerId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `PendingRead_ownerId_idx` ON `PendingRead`(`ownerId`);
