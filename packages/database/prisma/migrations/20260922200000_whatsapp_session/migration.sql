-- Fase 4A (ADR-019): conexão de WhatsApp por usuário.
--
-- Só CRIA uma tabela nova, vazia. Não altera nem apaga nada: campanhas, grupos, envios,
-- métricas, WhatsAppAccount (ritmo por número) e os arquivos de sessão do Baileys ficam
-- exatamente como estão. Ninguém precisa ler o QR de novo.
--
-- `accountJid` é único, mas permite vários NULL (MySQL): antes do pareamento a conexão ainda
-- não tem número, e um número pareado pertence a um único usuário.

-- CreateTable
CREATE TABLE `WhatsAppSession` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accountJid` VARCHAR(191) NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'disconnected',
    `lastConnectedAt` DATETIME(3) NULL,
    `lastError` VARCHAR(255) NULL,
    `autoConnect` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WhatsAppSession_userId_key`(`userId`),
    UNIQUE INDEX `WhatsAppSession_accountJid_key`(`accountJid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WhatsAppSession` ADD CONSTRAINT `WhatsAppSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
