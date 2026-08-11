import { describe, expect, it } from "vitest";
import { recalculateReturnRefunds, type DiscountEngineRule } from "./discount-engine.server";

const buy3Get20Rule: DiscountEngineRule = {
  discountTitleMatch: "Buy 3 Get 20% off",
  discountCode: null,
  minQuantity: 3,
  minAmount: null,
  appliesTo: "ALL_ITEMS",
  scopeProductIds: null,
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
    });

    expect(result.lineItems[0].stillQualifies).toBeNull();
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
    expect(result.lineItems[0].note).toMatch(/not configured/i);
  });

  it("supports an amount-threshold (minAmount) discount rule", () => {
    const spend200Rule: DiscountEngineRule = {
      discountTitleMatch: "Spend $200 Save 15%",
      discountCode: null,
      minQuantity: null,
      minAmount: 200,
      appliesTo: "ALL_ITEMS",
      scopeProductIds: null,
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
    });

    expect(result.lineItems[0].hadDiscount).toBe(false);
    expect(result.lineItems[0].recalculatedRefund).toBe(80);
  });
});
