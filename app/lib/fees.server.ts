import db from "../db.server";

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

  const restockingFeeType = restocking?.feeType ?? "PERCENTAGE";
  const restockingFeeValue = restocking?.value ?? 0;
  const restockingFeeAmount =
    restockingFeeType === "PERCENTAGE"
      ? (refundBaseAmount * Number(restockingFeeValue)) / 100
      : Number(restockingFeeValue);

  const labelFeePerItem = Number(label?.amountPerItem ?? 5.99);
  const labelFeeAmount = labelFeePerItem * itemCount;

  return {
    restockingFeeAmount: restockingFeeAmount.toFixed(2),
    restockingFeeAvailable: restocking?.isActive ?? true,
    restockingFeeType,
    restockingFeeValue: restockingFeeValue.toString(),
    labelFeeAmount: labelFeeAmount.toFixed(2),
    labelFeePerItem: labelFeePerItem.toFixed(2),
    labelFeeAvailable: label?.isActive ?? true,
  };
}
