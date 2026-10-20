export type PriceDiffDirection = "CHARGE" | "REFUND" | "NONE";

const CENTS = 100;

/**
 * Compares the original per-unit price the customer paid against the target
 * exchange variant's price, scaled by the quantity being returned. Cents-based
 * integer math avoids floating point drift on money.
 */
export function calculatePriceDifference(
  originalUnitPrice: string | number,
  targetUnitPrice: string | number,
  quantity: number,
): { direction: PriceDiffDirection; amount: string } {
  const originalCents = Math.round(Number(originalUnitPrice) * CENTS) * quantity;
  const targetCents = Math.round(Number(targetUnitPrice) * CENTS) * quantity;
  const diffCents = targetCents - originalCents;

  const direction: PriceDiffDirection = diffCents > 0 ? "CHARGE" : diffCents < 0 ? "REFUND" : "NONE";
  const amount = (Math.abs(diffCents) / CENTS).toFixed(2);

  return { direction, amount };
}

/** Total value of the replacement item(s) being sent out, in cents-safe terms. */
export function sumExchangeSubtotal(
  selections: Array<{ targetUnitPrice: string | number; quantity: number }>,
): string {
  const cents = selections.reduce((sum, s) => sum + Math.round(Number(s.targetUnitPrice) * CENTS) * s.quantity, 0);
  return (cents / CENTS).toFixed(2);
}

/**
 * Shipping on an exchange's replacement shipment. Mirrors a storefront
 * free-shipping minimum: replacement items worth at least the threshold ship
 * free, anything less pays the flat fee. A missing threshold means never free.
 * No exchange (subtotal 0) or an inactive config means no charge.
 */
export function calculateExchangeShippingFee({
  subtotal,
  feeAmount,
  freeShippingThreshold,
  isActive,
}: {
  subtotal: string | number;
  feeAmount: string | number;
  freeShippingThreshold: string | number | null;
  isActive: boolean;
}): { amount: string; freeShippingApplied: boolean } {
  const subtotalCents = Math.round(Number(subtotal) * CENTS);
  if (!isActive || subtotalCents <= 0) return { amount: "0.00", freeShippingApplied: false };

  if (freeShippingThreshold != null && subtotalCents >= Math.round(Number(freeShippingThreshold) * CENTS)) {
    return { amount: "0.00", freeShippingApplied: true };
  }
  return { amount: (Math.round(Number(feeAmount) * CENTS) / CENTS).toFixed(2), freeShippingApplied: false };
}
