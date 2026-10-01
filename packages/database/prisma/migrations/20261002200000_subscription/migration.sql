-- Plano da conta (ADR-050): nome, valor, vencimento, pausa e grupos por campanha. Aditiva.

-- CreateTable
CREATE TABLE `Subscription` (
    `userId` VARCHAR(191) NOT NULL,
    `plan` VARCHAR(40) NULL,
    `priceCents` INTEGER NULL,
    `dueDate` DATE NULL,
    `pausedAt` DATETIME(3) NULL,
    `maxGroups` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

