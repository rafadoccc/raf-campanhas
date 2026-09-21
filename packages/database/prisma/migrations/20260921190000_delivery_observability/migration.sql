-- AlterTable
ALTER TABLE `Delivery` ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `deliveredAt` DATETIME(3) NULL,
    ADD COLUMN `errorCode` VARCHAR(64) NULL,
    ADD COLUMN `sendContext` VARCHAR(160) NULL,
    ADD COLUMN `sendReturnedAt` DATETIME(3) NULL,
    ADD COLUMN `serverRejectedAt` DATETIME(3) NULL;

