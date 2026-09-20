CREATE TABLE "CampaignMedia" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignMedia_kind_check" CHECK ("kind" IN ('image', 'video')),
  CONSTRAINT "CampaignMedia_size_check" CHECK ("size" > 0 AND "size" = octet_length("data"))
);
ALTER TABLE "Campaign" ADD COLUMN "mediaId" TEXT;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "CampaignMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
