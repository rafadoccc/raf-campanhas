-- ADR-041: proteção do número. Regras de envio por conta (janela de silêncio, limite diário,
-- intervalo por grupo, pausa automática), registro da pausa automática e índice para contar os
-- envios do dia. Aditiva: sem linha em SendingPolicy valem os padrões do código.

-- AlterTable
ALTER TABLE `WhatsAppSession` ADD COLUMN `safetyPausedAt` DATETIME(3) NULL,
    ADD COLUMN `safetyReason` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `SendingPolicy` (
    `userId` VARCHAR(191) NOT NULL,
    `quietStart` INTEGER NULL,
    `quietEnd` INTEGER NULL,
    `dailyLimit` INTEGER NULL,
    `groupGapMinutes` INTEGER NULL,
    `autoPause` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Delivery_attemptedAt_idx` ON `Delivery`(`attemptedAt`);

-- AddForeignKey
ALTER TABLE `SendingPolicy` ADD CONSTRAINT `SendingPolicy_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
