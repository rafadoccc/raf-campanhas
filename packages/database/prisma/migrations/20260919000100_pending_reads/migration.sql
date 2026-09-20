CREATE TABLE "PendingRead" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "groupJid" TEXT NOT NULL,
  "accountJid" TEXT NOT NULL,
  "participant" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PendingRead_nextAttemptAt_idx" ON "PendingRead"("nextAttemptAt");
