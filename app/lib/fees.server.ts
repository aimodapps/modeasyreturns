import db from "../db.server";
import { sumExchangeSubtotal, calculateExchangeShippingFee } from "./exchange.server";

export type ShippingFeeQuote = {
  restockingFeeAmount: string;
  restockingFeeAvailable: boolean;
  restockingFeeType: "PERCENTAGE" | "FIXED_AMOUNT";
  restockingFeeValue: string;
  labelFeeAmount: string;
  labelFeePerItem: string;
  labelFeeAvailable: boolean;
};

/**
 * Quotes both shipping options against a return's refund-eligible total, so
 * the customer can compare "own carrier" vs "return label" before choosing.
 * refundBaseAmount should be the pre-fee refund total (sum of returned item
 * unit prices x quantity) -- restocking fee is a percentage/fixed cut of that,
 * label fee is a flat amount multiplied by the number of items being shipped.
 */
export async function quoteShippingFees(
  shopDomain: string,
  { refundBaseAmount, itemCount }: { refundBaseAmount: number; itemCount: number },
): Promise<ShippingFeeQuote> {
  const [restocking, label] = await Promise.all([
    db.restockingFeeConfig.findUnique({ where: { shopDomain } }),
    db.returnLabelFeeConfig.findUnique({ where: { shopDomain } }),
  ]);

  const restockingFeeActive = restocking?.isActive ?? true;
  const restockingFeeType = restocking?.feeType ?? "PERCENTAGE";
  const restockingFeeValue = restocking?.value ?? 0;
  const restockingFeeAmount = restockingFeeActive
    ? restockingFeeType === "PERCENTAGE"
      ? (refundBaseAmount * Number(restockingFeeValue)) / 100
      : Number(restockingFeeValue)
    : 0;

  const labelFeeActive = label?.isActive ?? true;
  const labelFeePerItem = labelFeeActive ? Number(label?.amountPerItem ?? 5.99) : 0;
  const labelFeeAmount = labelFeePerItem * itemCount;

  return {
    restockingFeeAmount: restockingFeeAmount.toFixed(2),
    restockingFeeAvailable: restockingFeeActive,
    restockingFeeType,
    restockingFeeValue: restockingFeeValue.toString(),
    labelFeeAmount: labelFeeAmount.toFixed(2),
    labelFeePerItem: labelFeePerItem.toFixed(2),
    labelFeeAvailable: labelFeeActive,
  };
}

export type ExchangeShippingQuote = {
  amount: string;
  subtotal: string;
  freeShippingApplied: boolean;
  /** Config the quote was made against, so the UI can explain the rule ("free at $65+"). */
  feeAmount: string | null;
  freeShippingThreshold: string | null;
};

/**
 * Shipping for the replacement item(s) of an exchange. Without a saved,
 * active ExchangeShippingFeeConfig this quotes $0, so exchanges keep shipping
 * free until the merchant opts in under Shipping & fees.
 */
export async function quoteExchangeShippingFee(
  shopDomain: string,
  selections: Array<{ targetUnitPrice: string | number; quantity: number }>,
): Promise<ExchangeShippingQuote> {
  const subtotal = sumExchangeSubtotal(selections);
  const config = await db.exchangeShippingFeeConfig.findUnique({ where: { shopDomain } });
  if (!config) {
    return { amount: "0.00", subtotal, freeShippingApplied: false, feeAmount: null, freeShippingThreshold: null };
  }

  const { amount, freeShippingApplied } = calculateExchangeShippingFee({
    subtotal,
    feeAmount: config.feeAmount.toString(),
    freeShippingThreshold: config.freeShippingThreshold?.toString() ?? null,
    isActive: config.isActive,
  });
  return {
    amount,
    subtotal,
    freeShippingApplied,
    feeAmount: config.isActive ? config.feeAmount.toString() : null,
    freeShippingThreshold: config.isActive ? (config.freeShippingThreshold?.toString() ?? null) : null,
  };
}
