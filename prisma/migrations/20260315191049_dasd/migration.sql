-- CreateTable
CREATE TABLE "EmailDeletedMessage" (
    "id" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "messageId" TEXT,
    "subject" TEXT,
    "fromAddress" TEXT,
    "deletedByUserId" TEXT,
    "deletedByUserName" TEXT,
    "deletedByUserEmail" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDeletedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailBlockedSender" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "reason" TEXT,
    "blockedByUserId" TEXT,
    "blockedByUserName" TEXT,
    "blockedByUserEmail" TEXT,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailBlockedSender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailDeletedMessage_messageId_idx" ON "EmailDeletedMessage"("messageId");

-- CreateIndex
CREATE INDEX "EmailDeletedMessage_deletedAt_idx" ON "EmailDeletedMessage"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeletedMessage_mailbox_uid_key" ON "EmailDeletedMessage"("mailbox", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "EmailBlockedSender_normalizedEmail_key" ON "EmailBlockedSender"("normalizedEmail");

-- CreateIndex
CREATE INDEX "EmailBlockedSender_blockedAt_idx" ON "EmailBlockedSender"("blockedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_mailbox_idx" ON "EmailMessage"("mailbox");
