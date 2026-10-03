-- Arquivar campanhas e limite de campanhas por conta (ADR-054). Aditiva.

-- AlterTable
ALTER TABLE `Campaign` ADD COLUMN `archivedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Subscription` ADD COLUMN `maxCampaigns` INTEGER NULL;

