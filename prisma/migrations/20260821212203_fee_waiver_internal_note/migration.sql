-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "internalNote" TEXT,
ADD COLUMN     "shippingFeeWaived" BOOLEAN NOT NULL DEFAULT false;
