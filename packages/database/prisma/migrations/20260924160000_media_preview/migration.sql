-- ADR-026: cor predominante e miniatura das imagens de campanha, e índice da lista paginada.
-- Só acrescenta colunas opcionais e um índice. Nenhuma mídia é alterada ou apagada; as imagens
-- que já existem ganham cor e miniatura na primeira partida (preenchimento em segundo plano).

-- AlterTable
ALTER TABLE `CampaignMedia` ADD COLUMN `color` VARCHAR(7) NULL,
    ADD COLUMN `thumbnail` MEDIUMBLOB NULL;

-- CreateIndex
CREATE INDEX `Campaign_userId_createdAt_idx` ON `Campaign`(`userId`, `createdAt`);
