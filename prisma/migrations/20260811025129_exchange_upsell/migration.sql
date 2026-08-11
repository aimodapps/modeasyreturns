-- CreateEnum
CREATE TYPE "PriceDiffDirection" AS ENUM ('CHARGE', 'REFUND', 'NONE');

-- CreateTable
CREATE TABLE "ExchangeUpsellProduct" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeUpsellProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeSelection" (
    "id" TEXT NOT NULL,
    "returnRequestLineItemId" TEXT NOT NULL,
    "targetProductId" TEXT NOT NULL,
    "targetVariantId" TEXT NOT NULL,
    "targetTitle" TEXT NOT NULL,
    "targetVariantTitle" TEXT,
    "targetImageUrl" TEXT,
    "targetUnitPrice" DECIMAL(10,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "priceDifference" DECIMAL(10,2) NOT NULL,
    "direction" "PriceDiffDirection" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeSelection_returnRequestLineItemId_key" ON "ExchangeSelection"("returnRequestLineItemId");

-- AddForeignKey
ALTER TABLE "ExchangeSelection" ADD CONSTRAINT "ExchangeSelection_returnRequestLineItemId_fkey" FOREIGN KEY ("returnRequestLineItemId") REFERENCES "ReturnRequestLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
