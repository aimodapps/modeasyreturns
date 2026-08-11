-- CreateEnum
CREATE TYPE "ShippingMethod" AS ENUM ('OWN_CARRIER', 'RETURN_LABEL');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "shippingFeeAmount" DECIMAL(10,2),
ADD COLUMN     "shippingMethod" "ShippingMethod",
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RestockingFeeConfig" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "feeType" "FeeType" NOT NULL DEFAULT 'PERCENTAGE',
    "value" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestockingFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnLabelFeeConfig" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "amountPerItem" DECIMAL(10,2) NOT NULL DEFAULT 5.99,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnLabelFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestockingFeeConfig_shopDomain_key" ON "RestockingFeeConfig"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLabelFeeConfig_shopDomain_key" ON "ReturnLabelFeeConfig"("shopDomain");
