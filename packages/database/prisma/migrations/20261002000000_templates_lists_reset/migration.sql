-- ADR-047: modelos de campanha (Campaign.isTemplate), listas de grupos e pedidos de nova senha.
-- Aditiva: nenhuma linha existente muda; campanhas atuais ficam com isTemplate = false.

-- AlterTable
ALTER TABLE `Campaign` ADD COLUMN `isTemplate` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `GroupList` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GroupList_userId_name_key`(`userId`, `name`),
    UNIQUE INDEX `GroupList_userId_id_key`(`userId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GroupListItem` (
    `listId` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,

    INDEX `GroupListItem_userId_listId_idx`(`userId`, `listId`),
    INDEX `GroupListItem_userId_groupId_idx`(`userId`, `groupId`),
    PRIMARY KEY (`listId`, `groupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PasswordReset` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PasswordReset_tokenHash_key`(`tokenHash`),
    INDEX `PasswordReset_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `GroupList` ADD CONSTRAINT `GroupList_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GroupListItem` ADD CONSTRAINT `GroupListItem_userId_listId_fkey` FOREIGN KEY (`userId`, `listId`) REFERENCES `GroupList`(`userId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GroupListItem` ADD CONSTRAINT `GroupListItem_userId_groupId_fkey` FOREIGN KEY (`userId`, `groupId`) REFERENCES `Group`(`userId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PasswordReset` ADD CONSTRAINT `PasswordReset_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

