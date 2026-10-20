import { describe, expect, it } from "vitest";
import {
  calculateExchangeShippingFee,
  sumExchangeSubtotal,
} from "./exchange.server";

const config = {
  feeAmount: "6.95",
  freeShippingThreshold: "65.00",
  isActive: true,
};

describe("sumExchangeSubtotal", () => {
  it("sums unit price x quantity without float drift", () => {
    expect(
      sumExchangeSubtotal([
        { targetUnitPrice: "19.99", quantity: 3 },
        { targetUnitPrice: "0.10", quantity: 1 },
      ]),
    ).toBe("60.07");
  });

  it("is zero with no replacements", () => {
    expect(sumExchangeSubtotal([])).toBe("0.00");
  });
});

describe("calculateExchangeShippingFee", () => {
  it("charges the flat fee below the free-shipping threshold", () => {
    expect(
      calculateExchangeShippingFee({ ...config, subtotal: "64.99" }),
    ).toEqual({
      amount: "6.95",
      freeShippingApplied: false,
    });
  });

  it("is free exactly at the threshold", () => {
    expect(
      calculateExchangeShippingFee({ ...config, subtotal: "65.00" }),
    ).toEqual({
      amount: "0.00",
      freeShippingApplied: true,
    });
  });

  it("is free above the threshold", () => {
    expect(
      calculateExchangeShippingFee({ ...config, subtotal: "120" }).amount,
    ).toBe("0.00");
  });

  it("always charges when no threshold is set", () => {
    expect(
      calculateExchangeShippingFee({
        ...config,
        freeShippingThreshold: null,
        subtotal: "500",
      }).amount,
    ).toBe("6.95");
  });

  it("charges nothing when the config is inactive", () => {
    expect(
      calculateExchangeShippingFee({
        ...config,
        isActive: false,
        subtotal: "20",
      }).amount,
    ).toBe("0.00");
  });

  it("charges nothing when there is no exchange", () => {
    expect(
      calculateExchangeShippingFee({ ...config, subtotal: "0.00" }),
    ).toEqual({
      amount: "0.00",
      freeShippingApplied: false,
    });
  });
});
