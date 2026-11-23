import { describe, expect, it } from "vitest";
import { computeRefundSettlement } from "./refund-settlement";

const base = { appNetRefundCents: 0, reallocationAdjustmentCents: 0, waivedAfterApprovalCents: 0 };

describe("computeRefundSettlement", () => {
  it("refunds exactly what Shopify says the customer is owed", () => {
    // Order #MOD17748: two items (39.99 + 36.00) minus a 13.98 fee.
    expect(computeRefundSettlement({ ...base, outstandingCents: -6201, appNetRefundCents: 6201 })).toEqual({
      refundCents: 6201,
      balanceDueCents: 0,
    });
  });

  it("uses Shopify's figure over the app's when tax makes them differ", () => {
    // Item 31.99 + 2.24 tax, fee 6.99: Shopify owes 27.24, the app's item-only maths says 25.00.
    expect(computeRefundSettlement({ ...base, outstandingCents: -2724, appNetRefundCents: 2500 }).refundCents).toBe(
      2724,
    );
  });

  it("holds back the discount reallocation adjustment", () => {
    expect(
      computeRefundSettlement({ ...base, outstandingCents: -8000, reallocationAdjustmentCents: 4000 }).refundCents,
    ).toBe(4000);
  });

  it("adds back a fee waived after approval", () => {
    expect(
      computeRefundSettlement({ ...base, outstandingCents: -2500, waivedAfterApprovalCents: 699 }).refundCents,
    ).toBe(3199);
  });

  it("never goes below zero", () => {
    expect(
      computeRefundSettlement({ ...base, outstandingCents: -500, reallocationAdjustmentCents: 2000 }).refundCents,
    ).toBe(0);
  });

  it("refunds nothing and reports the balance when the customer owes", () => {
    expect(computeRefundSettlement({ ...base, outstandingCents: 2883, appNetRefundCents: 1000 })).toEqual({
      refundCents: 0,
      balanceDueCents: 2883,
    });
  });

  it("refunds nothing when the balance is settled", () => {
    expect(computeRefundSettlement({ ...base, outstandingCents: 0 })).toEqual({ refundCents: 0, balanceDueCents: 0 });
  });

  it("falls back to the app's own amount when the balance is unreadable", () => {
    expect(computeRefundSettlement({ ...base, outstandingCents: null, appNetRefundCents: 6201 })).toEqual({
      refundCents: 6201,
      balanceDueCents: 0,
    });
  });
});
