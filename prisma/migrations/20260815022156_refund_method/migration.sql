-- CreateEnum
CREATE TYPE "RefundMethod" AS ENUM ('ORIGINAL_PAYMENT_METHOD', 'STORE_CREDIT');

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "refundMethod" "RefundMethod";
