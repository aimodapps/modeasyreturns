import { describe, expect, it } from "vitest";
import { paidUnitPrice } from "./shopify-admin.server";

const money = (amount: string) => ({ shopMoney: { amount } });

describe("paidUnitPrice", () => {
  it("uses the after-all-discounts price when a code or order discount lowered it", () => {
    expect(
      paidUnitPrice({
        discountedUnitPriceSet: money("50.00"),
        discountedUnitPriceAfterAllDiscountsSet: money("40.00"),
      }),
    ).toBe("40.00");
  });

  it("matches the line-level price when there is no extra discount", () => {
    expect(
      paidUnitPrice({
        discountedUnitPriceSet: money("45.00"),
        discountedUnitPriceAfterAllDiscountsSet: money("45.00"),
      }),
    ).toBe("45.00");
  });

  it("never exceeds the line-level price (Shopify's value is approximate)", () => {
    expect(
      paidUnitPrice({
        discountedUnitPriceSet: money("10.96"),
        discountedUnitPriceAfterAllDiscountsSet: money("10.97"),
      }),
    ).toBe("10.96");
  });

  it("falls back to the line-level price when the after-all value is missing", () => {
    expect(paidUnitPrice({ discountedUnitPriceSet: money("50.00") })).toBe("50.00");
  });

  it("falls back to 0.00 when neither is present", () => {
    expect(paidUnitPrice({})).toBe("0.00");
  });
});
