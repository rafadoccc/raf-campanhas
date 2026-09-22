-- Multiusuário, Fase 2 (ADR-017): Group, Campaign e CampaignMedia ganham dono (userId).
--
-- Os dados que já existem vão para o ÚNICO SUPER_ADMIN ativo. Se houver dados e não houver
-- exatamente um SUPER_ADMIN ativo (nenhum ou mais de um), a migration PARA na primeira
-- instrução, antes de alterar qualquer tabela, com o erro:
--   Check constraint 'fase2_precisa_de_um_unico_SUPER_ADMIN_ativo' is violated.
-- Nesse caso: deixe um único SUPER_ADMIN ativo (os outros como USER ou desativados), rode
--   npx prisma migrate resolve --rolled-back 20260922160000_data_ownership --schema=packages/database/prisma/schema.prisma
-- e reinicie. Banco sem dados (instalação nova) não precisa de SUPER_ADMIN aqui.
--
-- Nada é apagado nem duplicado: só colunas, índices e chaves novas. Envios, leituras,
-- mensagens e agendamentos não mudam (herdam o dono pela campanha).

-- 1) Trava: exatamente um SUPER_ADMIN ativo quando há dados a atribuir.
CREATE TEMPORARY TABLE `_fase2_dono` (
    `ok` TINYINT NOT NULL,
    CONSTRAINT `fase2_precisa_de_um_unico_SUPER_ADMIN_ativo` CHECK (`ok` = 1)
);
INSERT INTO `_fase2_dono` (`ok`)
SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM `Campaign`) AND NOT EXISTS (SELECT 1 FROM `Group`) AND NOT EXISTS (SELECT 1 FROM `CampaignMedia`) THEN 1
    WHEN (SELECT COUNT(*) FROM `User` WHERE `role` = 'SUPER_ADMIN' AND `disabledAt` IS NULL) = 1 THEN 1
    ELSE 0
END;
DROP TEMPORARY TABLE `_fase2_dono`;

-- 2) Colunas opcionais, preenchidas com o SUPER_ADMIN, e só então obrigatórias.
ALTER TABLE `Group` ADD COLUMN `userId` VARCHAR(191) NULL;
ALTER TABLE `Campaign` ADD COLUMN `userId` VARCHAR(191) NULL;
ALTER TABLE `CampaignMedia` ADD COLUMN `userId` VARCHAR(191) NULL;
ALTER TABLE `CampaignGroup` ADD COLUMN `userId` VARCHAR(191) NULL;

UPDATE `Group` SET `userId` = (SELECT `id` FROM `User` WHERE `role` = 'SUPER_ADMIN' AND `disabledAt` IS NULL);
UPDATE `Campaign` SET `userId` = (SELECT `id` FROM `User` WHERE `role` = 'SUPER_ADMIN' AND `disabledAt` IS NULL);
UPDATE `CampaignMedia` SET `userId` = (SELECT `id` FROM `User` WHERE `role` = 'SUPER_ADMIN' AND `disabledAt` IS NULL);
UPDATE `CampaignGroup` AS cg JOIN `Campaign` AS c ON c.`id` = cg.`campaignId` SET cg.`userId` = c.`userId`;

ALTER TABLE `Group` MODIFY `userId` VARCHAR(191) NOT NULL;
ALTER TABLE `Campaign` MODIFY `userId` VARCHAR(191) NOT NULL;
ALTER TABLE `CampaignMedia` MODIFY `userId` VARCHAR(191) NOT NULL;
ALTER TABLE `CampaignGroup` MODIFY `userId` VARCHAR(191) NOT NULL;

-- 3) Grupo único POR DONO (dois usuários podem estar no mesmo grupo do WhatsApp).
CREATE UNIQUE INDEX `Group_userId_externalId_key` ON `Group`(`userId`, `externalId`);
DROP INDEX `Group_externalId_key` ON `Group`;

-- 4) Chaves (userId, id) para as chaves estrangeiras compostas.
CREATE UNIQUE INDEX `Group_userId_id_key` ON `Group`(`userId`, `id`);
CREATE UNIQUE INDEX `Campaign_userId_id_key` ON `Campaign`(`userId`, `id`);
CREATE UNIQUE INDEX `CampaignMedia_userId_id_key` ON `CampaignMedia`(`userId`, `id`);
CREATE INDEX `Campaign_userId_mediaId_idx` ON `Campaign`(`userId`, `mediaId`);
CREATE INDEX `CampaignGroup_userId_campaignId_idx` ON `CampaignGroup`(`userId`, `campaignId`);
CREATE INDEX `CampaignGroup_userId_groupId_idx` ON `CampaignGroup`(`userId`, `groupId`);

-- 5) Troca das chaves simples pelas compostas. O índice `Campaign_mediaId_fkey`, criado pelo
--    MySQL junto com a chave antiga, continua existindo e está declarado no schema.
ALTER TABLE `Campaign` DROP FOREIGN KEY `Campaign_mediaId_fkey`;
ALTER TABLE `CampaignGroup` DROP FOREIGN KEY `CampaignGroup_campaignId_fkey`;
ALTER TABLE `CampaignGroup` DROP FOREIGN KEY `CampaignGroup_groupId_fkey`;

ALTER TABLE `Group` ADD CONSTRAINT `Group_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Campaign` ADD CONSTRAINT `Campaign_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CampaignMedia` ADD CONSTRAINT `CampaignMedia_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
-- Campanha só usa mídia do mesmo dono.
ALTER TABLE `Campaign` ADD CONSTRAINT `Campaign_userId_mediaId_fkey` FOREIGN KEY (`userId`, `mediaId`) REFERENCES `CampaignMedia`(`userId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
-- Campanha só usa grupo do mesmo dono (CampaignGroup.userId = dono da campanha = dono do grupo).
ALTER TABLE `CampaignGroup` ADD CONSTRAINT `CampaignGroup_userId_campaignId_fkey` FOREIGN KEY (`userId`, `campaignId`) REFERENCES `Campaign`(`userId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CampaignGroup` ADD CONSTRAINT `CampaignGroup_userId_groupId_fkey` FOREIGN KEY (`userId`, `groupId`) REFERENCES `Group`(`userId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
