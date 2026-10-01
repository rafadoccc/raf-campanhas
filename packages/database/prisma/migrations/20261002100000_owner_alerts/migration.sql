-- Avisos no WhatsApp do dono (ADR-048): preferencia da conta e fila de avisos. Aditiva.

-- CreateTable
CREATE TABLE `AlertSettings` (
    `userId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `phone` VARCHAR(20) NULL,
    `enabledAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OwnerAlert` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(120) NOT NULL,
    `text` VARCHAR(1000) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `error` VARCHAR(255) NULL,

    UNIQUE INDEX `OwnerAlert_key_key`(`key`),
    INDEX `OwnerAlert_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `OwnerAlert_sentAt_createdAt_idx`(`sentAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AlertSettings` ADD CONSTRAINT `AlertSettings_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OwnerAlert` ADD CONSTRAINT `OwnerAlert_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

