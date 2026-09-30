-- ADR-043: aquecimento de número novo. Guarda a que número a resposta "é novo?" se refere e
-- quando o aquecimento começou. Aditiva: sem resposta, nada muda no ritmo.

-- AlterTable
ALTER TABLE `WhatsAppSession` ADD COLUMN `warmupJid` VARCHAR(191) NULL,
    ADD COLUMN `warmupStartedAt` DATETIME(3) NULL;
