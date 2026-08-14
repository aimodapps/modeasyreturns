-- CreateEnum
CREATE TYPE "ExclusionType" AS ENUM ('PRODUCT', 'COLLECTION');

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "introDescription" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "logoWidthPx" INTEGER,
ADD COLUMN     "orderNumberPlaceholder" TEXT,
ADD COLUMN     "pageTitle" TEXT;

-- CreateTable
CREATE TABLE "ReturnExclusion" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "type" "ExclusionType" NOT NULL,
    "shopifyResourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnExclusion_shopDomain_idx" ON "ReturnExclusion"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnExclusion_shopDomain_shopifyResourceId_key" ON "ReturnExclusion"("shopDomain", "shopifyResourceId");
