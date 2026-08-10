import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../db.server";
import {
  findOrderForReturnLookup,
  type DiscountApplicationSummary,
  type ReturnableItem,
} from "./shopify-admin.server";

export const GENERIC_NOT_FOUND_MESSAGE =
  "We couldn't find a matching order. Please double-check your order number and email or phone number, then try again.";

export type OrderLookupResponse =
  | {
      eligible: true;
      order: { id: string; name: string };
      items: ReturnableItem[];
      discountApplications: DiscountApplicationSummary[];
    }
  | { eligible: false; error: string };

export async function performOrderLookup(
  admin: AdminApiContext,
  shopDomain: string,
  { orderNumber, email, phone }: { orderNumber: string; email?: string; phone?: string },
): Promise<OrderLookupResponse> {
  if (!orderNumber.trim() || (!email?.trim() && !phone?.trim())) {
    return {
      eligible: false,
      error: "Please provide your order number and either an email or phone number.",
    };
  }

  const order = await findOrderForReturnLookup(admin, { orderNumber, email, phone });
  if (!order) {
    return { eligible: false, error: GENERIC_NOT_FOUND_MESSAGE };
  }

  const shopSettings = await db.shopSettings.findUnique({ where: { shopDomain } });
  const returnWindowDays = shopSettings?.returnWindowDays ?? 30;
  const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
  const withinReturnWindow = orderAgeMs <= returnWindowDays * 24 * 60 * 60 * 1000;

  if (!withinReturnWindow || order.returnableItems.length === 0) {
    return {
      eligible: false,
      error:
        "This order has no items eligible for return. This can happen if the return window has passed, items are marked final sale, or everything has already been returned.",
    };
  }

  return {
    eligible: true,
    order: { id: order.id, name: order.name },
    items: order.returnableItems,
    discountApplications: order.discountApplications,
  };
}
