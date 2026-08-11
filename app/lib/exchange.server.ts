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
