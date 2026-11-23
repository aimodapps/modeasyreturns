/**
 * Decides how much to refund once a return has been processed in Shopify.
 *
 * Processing a return (returnProcess) makes Shopify itself remove the returned
 * items from the order and net the return fee, leaving the difference as the
 * order's outstanding balance -- negative when the customer is owed money.
 * That balance is the source of truth (it includes the tax on the returned
 * items, which this app's own item-price arithmetic doesn't), so the refund
 * starts from it and is only adjusted for the two things Shopify can't know:
 *
 *  - reallocationAdjustmentCents: how much less the customer gets because a
 *    discount no longer qualifies after this return (discount engine).
 *  - waivedAfterApprovalCents: fee staff waived after approval, which Shopify
 *    still deducts because the fee on a Return can't be changed once created.
 *
 * If the balance couldn't be read, falls back to the app's own figure.
 * All amounts are integer cents.
 */
export function computeRefundSettlement({
  outstandingCents,
  appNetRefundCents,
  reallocationAdjustmentCents,
  waivedAfterApprovalCents,
}: {
  /** Shopify's order balance after processing: negative = owed to the customer, positive = customer owes. Null if unreadable. */
  outstandingCents: number | null;
  appNetRefundCents: number;
  reallocationAdjustmentCents: number;
  waivedAfterApprovalCents: number;
}): { refundCents: number; balanceDueCents: number } {
  if (outstandingCents == null) {
    return { refundCents: Math.max(0, appNetRefundCents), balanceDueCents: 0 };
  }
  if (outstandingCents > 0) {
    // The customer owes (an exchange upcharge). What Shopify can invoice is
    // its own figure, so that's what is reported as due.
    return { refundCents: 0, balanceDueCents: outstandingCents };
  }
  const owedCents = -outstandingCents;
  return {
    refundCents: Math.max(0, owedCents - Math.max(0, reallocationAdjustmentCents) + Math.max(0, waivedAfterApprovalCents)),
    balanceDueCents: 0,
  };
}
