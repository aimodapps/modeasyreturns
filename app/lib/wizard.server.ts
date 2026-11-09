import db from "../db.server";
import type { OrderSnapshot } from "./order-lookup.server";

export async function loadReturnRequestOrThrow(id: string, shopDomain: string) {
  const returnRequest = await db.returnRequest.findFirst({
    where: { id, shopDomain },
    include: { lineItems: true, photos: true },
  });
  if (!returnRequest) {
    throw new Response("Not found", { status: 404 });
  }
  return {
    ...returnRequest,
    orderSnapshot: returnRequest.orderSnapshot as unknown as OrderSnapshot,
  };
}

/** Whether the shop currently lets customers choose an exchange. Off unless explicitly turned on in General settings. */
export async function areExchangesEnabled(shopDomain: string): Promise<boolean> {
  const settings = await db.shopSettings.findUnique({
    where: { shopDomain },
    select: { exchangesEnabled: true },
  });
  return settings?.exchangesEnabled ?? false;
}

/**
 * Drops exchange choices a customer made before exchanges were turned off, so
 * a draft that was already in progress can't still submit one.
 */
export async function clearExchangeSelections(lineItemIds: string[]): Promise<void> {
  if (lineItemIds.length === 0) return;
  await db.exchangeSelection.deleteMany({ where: { returnRequestLineItemId: { in: lineItemIds } } });
}
