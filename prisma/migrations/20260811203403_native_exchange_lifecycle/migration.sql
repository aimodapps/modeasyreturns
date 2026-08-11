-- CreateEnum
CREATE TYPE "ReturnLifecycleStage" AS ENUM ('AWAITING_RECEIPT', 'BALANCE_DUE', 'INVOICE_SENT', 'COMPLETED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'RETURN_RECEIVED';

-- AlterTable
ALTER TABLE "ExchangeSelection" DROP COLUMN "draftOrderId",
DROP COLUMN "draftOrderInvoiceUrl";

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "balanceDueAmount" DECIMAL(10,2),
ADD COLUMN     "balanceDueCurrency" TEXT,
ADD COLUMN     "invoiceSentAt" TIMESTAMP(3),
ADD COLUMN     "lifecycleStage" "ReturnLifecycleStage",
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "refundIssuedAmount" DECIMAL(10,2);
