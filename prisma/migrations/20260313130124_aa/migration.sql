-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "isRead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "readByUserEmail" TEXT,
ADD COLUMN     "readByUserId" TEXT,
ADD COLUMN     "readByUserName" TEXT;

-- CreateTable
CREATE TABLE "EmailViewEvent" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "viewerId" TEXT,
    "viewerName" TEXT,
    "viewerEmail" TEXT,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailViewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailViewEvent_emailId_idx" ON "EmailViewEvent"("emailId");

-- CreateIndex
CREATE INDEX "EmailViewEvent_viewedAt_idx" ON "EmailViewEvent"("viewedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_isRead_idx" ON "EmailMessage"("isRead");

-- AddForeignKey
ALTER TABLE "EmailViewEvent" ADD CONSTRAINT "EmailViewEvent_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
