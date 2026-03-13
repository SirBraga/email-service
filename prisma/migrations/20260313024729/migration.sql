-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "mailbox" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "fromAddresses" JSONB NOT NULL,
    "toAddresses" JSONB NOT NULL,
    "ccAddresses" JSONB NOT NULL,
    "bccAddresses" JSONB NOT NULL,
    "replyToAddresses" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3),
    "text" TEXT,
    "html" TEXT,
    "textPreview" TEXT,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT,
    "detectionMethod" TEXT,
    "receivedAt" TIMESTAMP(3),
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storedFilename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "contentDisposition" TEXT,
    "contentId" TEXT,
    "checksum" TEXT,
    "localRelativePath" TEXT,
    "localAbsolutePath" TEXT,
    "storageProvider" TEXT,
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "storageUrl" TEXT,
    "storageEtag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessage_messageId_idx" ON "EmailMessage"("messageId");

-- CreateIndex
CREATE INDEX "EmailMessage_receivedAt_idx" ON "EmailMessage"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_mailbox_uid_key" ON "EmailMessage"("mailbox", "uid");

-- CreateIndex
CREATE INDEX "EmailAttachment_emailId_idx" ON "EmailAttachment"("emailId");

-- CreateIndex
CREATE INDEX "EmailAttachment_storageBucket_storageKey_idx" ON "EmailAttachment"("storageBucket", "storageKey");

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
