-- One scheduled delivery per campaign, group, and exact scheduled timestamp.
CREATE UNIQUE INDEX "Delivery_campaignId_groupId_scheduledAt_key"
ON "Delivery"("campaignId", "groupId", "scheduledAt");
