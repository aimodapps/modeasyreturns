export type DiscountEngineOrderLineItem = {
  lineItemId: string;
  productId: string | null;
  quantity: number;
  originalUnitPrice: number;
  discountedUnitPrice: number;
};

export type DiscountEngineDiscountApplication = {
  title: string;
  code: string | null;
};

export type DiscountEngineRule = {
  discountTitleMatch: string;
  discountCode: string | null;
  minQuantity: number | null;
  minAmount: number | null;
  appliesTo: "ALL_ITEMS" | "SPECIFIC_PRODUCTS";
  scopeProductIds: string[] | null;
};

export type ReturningLineItemRef = {
  lineItemId: string;
  quantity: number;
};

export type LineItemReallocation = {
  lineItemId: string;
  matchedDiscountTitle: string | null;
  hadDiscount: boolean;
  stillQualifies: boolean | null;
  originalAllocatedRefund: number;
  recalculatedRefund: number;
  note: string;
};

export type ReallocationResult = {
  lineItems: LineItemReallocation[];
  totalOriginalRefund: number;
  totalRecalculatedRefund: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function findMatchingRule(
  discountApp: DiscountEngineDiscountApplication,
  rules: DiscountEngineRule[],
): DiscountEngineRule | null {
  return (
    rules.find(
      (rule) =>
        (rule.discountCode && discountApp.code && rule.discountCode === discountApp.code) ||
        rule.discountTitleMatch.trim().toLowerCase() === discountApp.title.trim().toLowerCase(),
    ) ?? null
  );
}

function inScope(item: DiscountEngineOrderLineItem, rule: DiscountEngineRule): boolean {
  if (rule.appliesTo === "ALL_ITEMS") return true;
  return Boolean(item.productId && rule.scopeProductIds?.includes(item.productId));
}

/**
 * Recomputes refund amounts for the items a customer is returning, taking
 * into account that an order-level or quantity-break discount might no
 * longer be earned once those items are removed from the order.
 *
 * Shopify's Admin API tells us what discount WAS applied to an order, but
 * never the rule behind it (e.g. "requires 3+ qualifying items") -- so we
 * mirror that rule into an admin-configured DiscountRule and re-evaluate it
 * here. If no rule is configured for a discount we see on the order, we
 * fail safe: refund at the original allocated (already-discounted) price
 * rather than guessing, and flag it so the summary/admin can call it out.
 */
export function recalculateReturnRefunds({
  allLineItems,
  discountApplications,
  rules,
  returningItems,
}: {
  allLineItems: DiscountEngineOrderLineItem[];
  discountApplications: DiscountEngineDiscountApplication[];
  rules: DiscountEngineRule[];
  returningItems: ReturningLineItemRef[];
}): ReallocationResult {
  const returningByLineItem = new Map(returningItems.map((r) => [r.lineItemId, r.quantity]));
  const results: LineItemReallocation[] = [];

  // Pre-compute, per matched rule, the group-level "still qualifies" +
  // group refund total once (not per returned item), then distribute.
  const groupCache = new Map<
    DiscountEngineRule,
    {
      stillQualifies: boolean;
      totalRefundOwedForReturnedItemsInGroup: number;
      returnedItemsInGroup: { lineItemId: string; shareBasis: number }[];
    }
  >();

  for (const discountApp of discountApplications) {
    const rule = findMatchingRule(discountApp, rules);
    if (!rule) continue;

    const groupItems = allLineItems.filter((item) => inScope(item, rule));
    if (groupItems.length === 0) continue;

    let keptQty = 0;
    let keptUndiscountedAmount = 0;
    let totalPaidForGroup = 0;
    const returnedItemsInGroup: { lineItemId: string; shareBasis: number }[] = [];

    for (const item of groupItems) {
      const returnedQty = returningByLineItem.get(item.lineItemId) ?? 0;
      const remainingQty = item.quantity - returnedQty;
      keptQty += remainingQty;
      keptUndiscountedAmount += remainingQty * item.originalUnitPrice;
      totalPaidForGroup += item.quantity * item.discountedUnitPrice;
      if (returnedQty > 0) {
        returnedItemsInGroup.push({
          lineItemId: item.lineItemId,
          shareBasis: returnedQty * item.originalUnitPrice,
        });
      }
    }

    let stillQualifies = true;
    if (rule.minQuantity != null) stillQualifies = stillQualifies && keptQty >= rule.minQuantity;
    if (rule.minAmount != null) stillQualifies = stillQualifies && keptUndiscountedAmount >= rule.minAmount;

    const totalRefundOwedForReturnedItemsInGroup = round2(totalPaidForGroup - keptUndiscountedAmount);

    groupCache.set(rule, {
      stillQualifies,
      totalRefundOwedForReturnedItemsInGroup,
      returnedItemsInGroup,
    });
  }

  for (const ref of returningItems) {
    const item = allLineItems.find((li) => li.lineItemId === ref.lineItemId);
    if (!item) continue;

    const originalAllocatedRefund = round2(item.discountedUnitPrice * ref.quantity);
    const hadDiscount = item.discountedUnitPrice < item.originalUnitPrice;

    if (!hadDiscount) {
      results.push({
        lineItemId: item.lineItemId,
        matchedDiscountTitle: null,
        hadDiscount: false,
        stillQualifies: null,
        originalAllocatedRefund,
        recalculatedRefund: originalAllocatedRefund,
        note: "No discount applied to this item.",
      });
      continue;
    }

    const discountApp = discountApplications.find((da) => {
      const rule = findMatchingRule(da, rules);
      if (!rule) return false;
      return inScope(item, rule);
    });
    const rule = discountApp ? findMatchingRule(discountApp, rules) : null;

    if (!rule || !discountApp) {
      results.push({
        lineItemId: item.lineItemId,
        matchedDiscountTitle: null,
        hadDiscount: true,
        stillQualifies: null,
        originalAllocatedRefund,
        recalculatedRefund: originalAllocatedRefund,
        note: "Discount rule not configured for this item's discount -- refunding at the original allocated price. Configure a rule under Settings -> Discount Rules to enable automatic recalculation.",
      });
      continue;
    }

    const group = groupCache.get(rule);
    if (!group || group.stillQualifies) {
      results.push({
        lineItemId: item.lineItemId,
        matchedDiscountTitle: discountApp.title,
        hadDiscount: true,
        stillQualifies: true,
        originalAllocatedRefund,
        recalculatedRefund: originalAllocatedRefund,
        note: `"${discountApp.title}" still qualifies after this return -- refund uses the original discounted price.`,
      });
      continue;
    }

    const totalShareBasis = group.returnedItemsInGroup.reduce((sum, r) => sum + r.shareBasis, 0);
    const myShare = group.returnedItemsInGroup.find((r) => r.lineItemId === item.lineItemId)?.shareBasis ?? 0;
    const recalculatedRefund =
      totalShareBasis > 0
        ? round2((myShare / totalShareBasis) * group.totalRefundOwedForReturnedItemsInGroup)
        : originalAllocatedRefund;

    results.push({
      lineItemId: item.lineItemId,
      matchedDiscountTitle: discountApp.title,
      hadDiscount: true,
      stillQualifies: false,
      originalAllocatedRefund,
      recalculatedRefund,
      note: `"${discountApp.title}" no longer qualifies after this return -- adjusted refund reflects the full price of what you're keeping.`,
    });
  }

  return {
    lineItems: results,
    totalOriginalRefund: round2(results.reduce((sum, r) => sum + r.originalAllocatedRefund, 0)),
    totalRecalculatedRefund: round2(results.reduce((sum, r) => sum + r.recalculatedRefund, 0)),
  };
}
