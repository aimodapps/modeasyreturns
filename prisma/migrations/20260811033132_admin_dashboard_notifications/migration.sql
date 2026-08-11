-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('RETURN_INITIATED', 'RETURN_APPROVED', 'RETURN_DENIED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "adminNote" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedByStaff" TEXT,
ADD COLUMN     "shopifyRefundId" TEXT,
ADD COLUMN     "shopifyReturnId" TEXT,
ADD COLUMN     "shopifyReturnName" TEXT;

-- CreateTable
CREATE TABLE "AdminNotificationLog" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "providerMessageId" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNotificationLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AdminNotificationLog" ADD CONSTRAINT "AdminNotificationLog_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
