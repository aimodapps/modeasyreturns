-- CreateEnum
CREATE TYPE "DiscountRuleType" AS ENUM ('ORDER_PERCENTAGE', 'ORDER_FIXED_AMOUNT', 'QTY_BREAK_PERCENTAGE', 'QTY_BREAK_FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "DiscountScope" AS ENUM ('ALL_ITEMS', 'SPECIFIC_PRODUCTS');

-- CreateTable
CREATE TABLE "DiscountRule" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "discountTitleMatch" TEXT NOT NULL,
    "discountCode" TEXT,
    "type" "DiscountRuleType" NOT NULL,
    "minQuantity" INTEGER,
    "minAmount" DECIMAL(10,2),
    "discountValue" DECIMAL(10,2) NOT NULL,
    "appliesTo" "DiscountScope" NOT NULL DEFAULT 'ALL_ITEMS',
    "scopeProductIds" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRule_pkey" PRIMARY KEY ("id")
);
