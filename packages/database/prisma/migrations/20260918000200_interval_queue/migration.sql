ALTER TABLE "Campaign" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'SCHEDULED',
 ADD COLUMN "intervalSeconds" INTEGER NOT NULL DEFAULT 180,
 ADD COLUMN "nextAvailableAt" TIMESTAMP(3), ADD COLUMN "pausedAt" TIMESTAMP(3),
 ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_interval_check" CHECK ("intervalSeconds" BETWEEN 60 AND 3600);
ALTER TABLE "CampaignGroup" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
WITH ordered AS (
 SELECT "campaignId", "groupId", row_number() OVER (PARTITION BY "campaignId" ORDER BY "createdAt", "groupId") - 1 AS n FROM "CampaignGroup"
) UPDATE "CampaignGroup" g SET "position" = ordered.n FROM ordered WHERE g."campaignId" = ordered."campaignId" AND g."groupId" = ordered."groupId";
ALTER TABLE "Delivery" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "attemptedAt" TIMESTAMP(3);
WITH ordered AS (
 SELECT id, row_number() OVER (PARTITION BY "campaignId" ORDER BY "scheduledAt", "createdAt", id) - 1 AS n FROM "Delivery"
) UPDATE "Delivery" d SET "sequence" = ordered.n FROM ordered WHERE d.id = ordered.id;
CREATE UNIQUE INDEX "Delivery_campaignId_sequence_key" ON "Delivery"("campaignId", "sequence");
CREATE INDEX "Delivery_providerId_idx" ON "Delivery"("providerId");
CREATE TABLE "DeliveryRead" (
 "id" TEXT NOT NULL PRIMARY KEY, "deliveryId" TEXT NOT NULL,
 "recipientHash" TEXT NOT NULL, "readAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DeliveryRead_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeliveryRead_deliveryId_recipientHash_key" ON "DeliveryRead"("deliveryId", "recipientHash");
CREATE INDEX "DeliveryRead_readAt_idx" ON "DeliveryRead"("readAt");
