ALTER TABLE "Campaign" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'simulator';
ALTER TABLE "Campaign" ADD COLUMN "accountJid" TEXT;
