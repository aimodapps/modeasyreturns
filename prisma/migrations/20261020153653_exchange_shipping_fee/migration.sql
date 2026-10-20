-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "exchangeShippingFeeAmount" DECIMAL(10,2),
ADD COLUMN     "exchangeShippingFeeWaived" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ExchangeShippingFeeConfig" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "feeAmount" DECIMAL(10,2) NOT NULL DEFAULT 6.95,
    "freeShippingThreshold" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeShippingFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeShippingFeeConfig_shopDomain_key" ON "ExchangeShippingFeeConfig"("shopDomain");

