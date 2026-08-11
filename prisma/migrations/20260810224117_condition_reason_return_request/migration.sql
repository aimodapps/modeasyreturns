-- CreateEnum
CREATE TYPE "ConditionAction" AS ENUM ('PROCEED', 'DENY');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'DENIED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ConditionOption" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "action" "ConditionAction" NOT NULL DEFAULT 'PROCEED',
    "denyMessage" TEXT,
    "denyLinkUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConditionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnReason" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "requiresPhoto" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "status" "ReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "orderSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequestLineItem" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "fulfillmentLineItemId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "conditionOptionId" TEXT,
    "conditionDenied" BOOLEAN NOT NULL DEFAULT false,
    "reasonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRequestLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConditionOption_shopDomain_code_key" ON "ConditionOption"("shopDomain", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnReason_shopDomain_code_key" ON "ReturnReason"("shopDomain", "code");

-- CreateIndex
CREATE INDEX "ReturnRequest_shopDomain_status_idx" ON "ReturnRequest"("shopDomain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequestLineItem_returnRequestId_fulfillmentLineItemId_key" ON "ReturnRequestLineItem"("returnRequestId", "fulfillmentLineItemId");

-- AddForeignKey
ALTER TABLE "ReturnRequestLineItem" ADD CONSTRAINT "ReturnRequestLineItem_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestLineItem" ADD CONSTRAINT "ReturnRequestLineItem_conditionOptionId_fkey" FOREIGN KEY ("conditionOptionId") REFERENCES "ConditionOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestLineItem" ADD CONSTRAINT "ReturnRequestLineItem_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "ReturnReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
