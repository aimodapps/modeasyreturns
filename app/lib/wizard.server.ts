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
