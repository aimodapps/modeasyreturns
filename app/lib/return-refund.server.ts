import db from "../db.server";
import { recalculateReturnRefunds, type LineItemReallocation } from "./discount-engine.server";
import type { OrderSnapshot } from "./order-lookup.server";

type ReturnRequestForRefund = {
  shopDomain: string;
  orderSnapshot: unknown;
  lineItems: Array<{ id: string; shopifyLineItemId: string; quantity: number }>;
};

export async function computeReturnRefundBreakdown(
  returnRequest: ReturnRequestForRefund,
): Promise<{ byLineItemId: Map<string, LineItemReallocation>; totalRecalculatedRefund: number }> {
  const snapshot = returnRequest.orderSnapshot as OrderSnapshot;

  const rules = await db.discountRule.findMany({
    where: { shopDomain: returnRequest.shopDomain, isActive: true },
  });

  const result = recalculateReturnRefunds({
    allLineItems: (snapshot.allLineItems ?? []).map((li) => ({
      lineItemId: li.lineItemId,
      productId: li.productId,
      quantity: li.quantity,
      originalUnitPrice: Number(li.originalUnitPrice),
      discountedUnitPrice: Number(li.discountedUnitPrice),
    })),
    discountApplications: snapshot.discountApplications ?? [],
    rules: rules.map((r) => ({
      discountTitleMatch: r.discountTitleMatch,
      discountCode: r.discountCode,
      minQuantity: r.minQuantity,
      minAmount: r.minAmount != null ? Number(r.minAmount) : null,
      appliesTo: r.appliesTo,
      scopeProductIds: Array.isArray(r.scopeProductIds) ? (r.scopeProductIds as string[]) : null,
      validFrom: r.validFrom ? r.validFrom.toISOString() : null,
      validUntil: r.validUntil ? r.validUntil.toISOString() : null,
    })),
    returningItems: returnRequest.lineItems.map((li) => ({
      lineItemId: li.shopifyLineItemId,
      quantity: li.quantity,
    })),
    orderCreatedAt: snapshot.orderCreatedAt,
  });

  const byLineItemId = new Map<string, LineItemReallocation>();
  for (const li of returnRequest.lineItems) {
    const match = result.lineItems.find((r) => r.lineItemId === li.shopifyLineItemId);
    if (match) byLineItemId.set(li.id, match);
  }

  return { byLineItemId, totalRecalculatedRefund: result.totalRecalculatedRefund };
}
