import { describe, expect, it } from "vitest";
import { recalculateReturnRefunds, type DiscountEngineRule } from "./discount-engine.server";

const ORDER_CREATED_AT = "2026-01-15T00:00:00Z";

const buy3Get20Rule: DiscountEngineRule = {
  discountTitleMatch: "Buy 3 Get 20% off",
  discountCode: null,
  minQuantity: 3,
  minAmount: null,
  appliesTo: "ALL_ITEMS",
  scopeProductIds: null,
  validFrom: null,
  validUntil: null,
};

describe("recalculateReturnRefunds", () => {
  it("recalculates a no-longer-qualifying quantity-break discount ($240 -> $40 refund)", () => {
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li3", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
    ];
    const discountApplications = [{ title: "Buy 3 Get 20% off", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [buy3Get20Rule],
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: ORDER_CREATED_AT,
    });

    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].stillQualifies).toBe(false);
    expect(result.lineItems[0].originalAllocatedRefund).toBe(80);
    expect(result.lineItems[0].recalculatedRefund).toBe(40);
  });

  it("keeps the discounted price when the discount still qualifies after the return", () => {
    // Buy 3 get 20% off, customer bought 4, returns 1 -- 3 remain, still qualifies.
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li3", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li4", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
    ];
    const discountApplications = [{ title: "Buy 3 Get 20% off", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [buy3Get20Rule],
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: ORDER_CREATED_AT,
    });

    expect(result.lineItems[0].stillQualifies).toBe(true);
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
  });

  it("fails safe (refunds at original allocated price) when no rule is configured for the discount", () => {
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li3", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
    ];
    const discountApplications = [{ title: "Some Unconfigured Deal", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [], // no rules configured
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: ORDER_CREATED_AT,
    });

    expect(result.lineItems[0].stillQualifies).toBeNull();
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
    expect(result.lineItems[0].note).toMatch(/no discount rule covers/i);
  });

  it("supports an amount-threshold (minAmount) discount rule", () => {
    const spend200Rule: DiscountEngineRule = {
      discountTitleMatch: "Spend $200 Save 15%",
      discountCode: null,
      minQuantity: null,
      minAmount: 200,
      appliesTo: "ALL_ITEMS",
      scopeProductIds: null,
      validFrom: null,
      validUntil: null,
    };
    // Two $150 items ($300 order, 15% off -> $255, $127.50 each). Return one:
    // kept amount = $150 (undiscounted) < $200 threshold -> no longer qualifies.
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 150, discountedUnitPrice: 127.5 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 150, discountedUnitPrice: 127.5 },
    ];
    const discountApplications = [{ title: "Spend $200 Save 15%", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [spend200Rule],
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: ORDER_CREATED_AT,
    });

    expect(result.lineItems[0].stillQualifies).toBe(false);
    // totalPaid = 255, keptUndiscounted = 150, refund = 105
    expect(result.lineItems[0].recalculatedRefund).toBe(105);
  });

  it("scopes a discount to specific products only", () => {
    const scopedRule: DiscountEngineRule = {
      discountTitleMatch: "Fragrance Bundle Deal",
      discountCode: null,
      minQuantity: 2,
      minAmount: null,
      appliesTo: "SPECIFIC_PRODUCTS",
      scopeProductIds: ["p1"],
      validFrom: null,
      validUntil: null,
    };
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 90 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 90 },
      // Unrelated product, should be ignored entirely by the scoped rule.
      { lineItemId: "li3", productId: "p2", quantity: 1, originalUnitPrice: 50, discountedUnitPrice: 50 },
    ];
    const discountApplications = [{ title: "Fragrance Bundle Deal", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [scopedRule],
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: ORDER_CREATED_AT,
    });

    expect(result.lineItems[0].stillQualifies).toBe(false);
    // totalPaid = 180, keptUndiscounted (li2 only) = 100, refund = 80
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
  });

  it("passes through items with no discount applied unchanged", () => {
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 2, originalUnitPrice: 40, discountedUnitPrice: 40 },
    ];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications: [],
      rules: [],
      returningItems: [{ lineItemId: "li1", quantity: 2 }],
      orderCreatedAt: ORDER_CREATED_AT,
    });

    expect(result.lineItems[0].hadDiscount).toBe(false);
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
  });

  it("only applies a rule whose campaign window covers the order's date -- reused title, different terms per run", () => {
    // Same discount title reused twice: the November run required 3 items,
    // the January run only required 2. An order placed in January must be
    // evaluated against the January terms, not whichever was saved last.
    const novemberRun: DiscountEngineRule = {
      discountTitleMatch: "Buy More Save More",
      discountCode: null,
      minQuantity: 3,
      minAmount: null,
      appliesTo: "ALL_ITEMS",
      scopeProductIds: null,
      validFrom: "2025-11-01T00:00:00Z",
      validUntil: "2025-11-30T23:59:59Z",
    };
    const januaryRun: DiscountEngineRule = {
      discountTitleMatch: "Buy More Save More",
      discountCode: null,
      minQuantity: 2,
      minAmount: null,
      appliesTo: "ALL_ITEMS",
      scopeProductIds: null,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2026-01-31T23:59:59Z",
    };
    // 2 items bought in January; return 1 -- under the January rule (min 2)
    // this no longer qualifies, but under the (wrong) November rule (min 3)
    // it would look like it never qualified to begin with either way, so
    // assert against the January rule's own title match note instead.
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 90 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 90 },
    ];
    const discountApplications = [{ title: "Buy More Save More", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [novemberRun, januaryRun],
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: "2026-01-15T00:00:00Z",
    });

    // Matched the January rule (min 2) -- 1 remaining item fails min 2, so
    // it no longer qualifies and gets reallocated, proving the January
    // (not November) terms were the ones applied.
    expect(result.lineItems[0].stillQualifies).toBe(false);
    expect(result.lineItems[0].note).toMatch(/no longer qualifies/i);
  });

  it("falls back to allocated price when the order falls outside every configured campaign window", () => {
    const decemberOnly: DiscountEngineRule = {
      discountTitleMatch: "Holiday Bundle",
      discountCode: null,
      minQuantity: 3,
      minAmount: null,
      appliesTo: "ALL_ITEMS",
      scopeProductIds: null,
      validFrom: "2025-12-01T00:00:00Z",
      validUntil: "2025-12-31T23:59:59Z",
    };
    const allLineItems = [
      { lineItemId: "li1", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li2", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
      { lineItemId: "li3", productId: "p1", quantity: 1, originalUnitPrice: 100, discountedUnitPrice: 80 },
    ];
    // Same title shows up on a March order -- outside the December window,
    // so it must NOT be treated as the December terms.
    const discountApplications = [{ title: "Holiday Bundle", code: null }];

    const result = recalculateReturnRefunds({
      allLineItems,
      discountApplications,
      rules: [decemberOnly],
      returningItems: [{ lineItemId: "li1", quantity: 1 }],
      orderCreatedAt: "2026-03-01T00:00:00Z",
    });

    expect(result.lineItems[0].stillQualifies).toBeNull();
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
    expect(result.lineItems[0].note).toMatch(/no discount rule covers/i);
  });
});
