import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../db.server";
import {
  findOrderForReturnLookup,
  type DiscountApplicationSummary,
  type ReturnableItem,
  type OrderLineItemForDiscount,
} from "./shopify-admin.server";
import { getExcludedProductIds, splitByExclusionRules } from "./return-exclusions.server";

export const GENERIC_NOT_FOUND_MESSAGE =
  "We couldn't find a matching order. Please double-check your order number and email or phone number, then try again.";

export type OrderLookupResponse =
  | {
      eligible: true;
      order: { id: string; name: string; createdAt: string };
      items: ReturnableItem[];
      excludedItems: ReturnableItem[];
      discountApplications: DiscountApplicationSummary[];
      allLineItems: OrderLineItemForDiscount[];
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

  const [shopSettings, exclusionRules] = await Promise.all([
    db.shopSettings.findUnique({ where: { shopDomain } }),
    db.returnExclusion.findMany({ where: { shopDomain } }),
  ]);
  const returnWindowDays = shopSettings?.returnWindowDays ?? 30;
  const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
  const withinReturnWindow = orderAgeMs <= returnWindowDays * 24 * 60 * 60 * 1000;

  if (!withinReturnWindow || order.returnableItems.length === 0) {
    return {
      eligible: false,
      error:
        "This order has no items eligible for return. This can happen if the return window has passed or everything has already been returned.",
    };
  }

  // Shown frozen/"Non-returnable" in the wizard rather than hidden, so a
  // customer who expects to find an item there sees why, instead of a
  // silent gap that reads like a bug.
  const excludedProductIds = await getExcludedProductIds(admin, exclusionRules);
  const { eligible, excluded } = splitByExclusionRules(order.returnableItems, excludedProductIds);

  if (shopSettings?.maxReturnsPerOrder != null) {
    // Counts submitted requests, not items -- a customer can still return
    // several items together in one request; this only limits how many
    // separate requests can be opened against the same order.
    const existingRequestCount = await db.returnRequest.count({
      where: { shopDomain, orderId: order.id, status: { not: "DRAFT" } },
    });
    if (existingRequestCount >= shopSettings.maxReturnsPerOrder) {
      return {
        eligible: false,
        error:
          existingRequestCount === 1
            ? "A return or exchange request has already been submitted for this order. Please contact us if you need further assistance."
            : "This order has already reached the maximum number of return or exchange requests allowed. Please contact us if you need further assistance.",
      };
    }
  }

  return {
    eligible: true,
    order: { id: order.id, name: order.name, createdAt: order.createdAt },
    items: eligible,
    excludedItems: excluded,
    discountApplications: order.discountApplications,
    allLineItems: order.allLineItems,
  };
}

export type OrderSnapshot = {
  items: ReturnableItem[];
  excludedItems: ReturnableItem[];
  discountApplications: DiscountApplicationSummary[];
  allLineItems: OrderLineItemForDiscount[];
  // Needed to match a DiscountRule's optional validFrom/validUntil campaign
  // window against the order it was actually applied to, not "today".
  orderCreatedAt: string;
};

export async function createDraftReturnRequest(
  shopDomain: string,
  {
    orderId,
    orderName,
    orderCreatedAt,
    email,
    phone,
    items,
    excludedItems,
    discountApplications,
    allLineItems,
  }: {
    orderId: string;
    orderName: string;
    orderCreatedAt: string;
    email?: string;
    phone?: string;
    items: ReturnableItem[];
    excludedItems: ReturnableItem[];
    discountApplications: DiscountApplicationSummary[];
    allLineItems: OrderLineItemForDiscount[];
  },
) {
  const snapshot: OrderSnapshot = { items, excludedItems, discountApplications, allLineItems, orderCreatedAt };
  return db.returnRequest.create({
    data: {
      shopDomain,
      orderId,
      orderName,
      customerEmail: email ?? null,
      customerPhone: phone ?? null,
      orderSnapshot: snapshot,
    },
  });
}
