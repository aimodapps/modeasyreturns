import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

export type ReturnableItem = {
  fulfillmentLineItemId: string;
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  unitPrice: string;
  currencyCode: string;
  imageUrl: string | null;
  productId: string | null;
  // "key: value" strings from the line item's own custom attributes (what
  // bundle-builder apps use to mark a specific purchase as part of a
  // bundle) -- matched against admin-configured LINE_ITEM_TAG exclusions.
  tagCandidates: string[];
};

export type DiscountApplicationSummary = {
  title: string;
  code: string | null;
  kind: "AUTOMATIC" | "CODE" | "MANUAL" | "SCRIPT" | "OTHER";
};

/**
 * Every line item on the order (not just returnable ones) with both its
 * original and discounted unit price -- the discount reallocation engine
 * needs the full order context to know what's being "kept" after a return.
 */
export type OrderLineItemForDiscount = {
  lineItemId: string;
  productId: string | null;
  quantity: number;
  originalUnitPrice: string;
  discountedUnitPrice: string;
};

export type OrderLookupResult = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
  discountApplications: DiscountApplicationSummary[];
  returnableItems: ReturnableItem[];
  allLineItems: OrderLineItemForDiscount[];
};

const ORDER_SEARCH_QUERY = `#graphql
  query OrderForReturnLookup($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        email
        phone
        createdAt
        discountApplications(first: 10) {
          nodes {
            targetType
            value {
              __typename
            }
            ... on AutomaticDiscountApplication {
              title
            }
            ... on DiscountCodeApplication {
              code
            }
            ... on ManualDiscountApplication {
              title
            }
            ... on ScriptDiscountApplication {
              title
            }
          }
        }
        lineItems(first: 100) {
          nodes {
            id
            quantity
            product {
              id
            }
            originalUnitPriceSet {
              shopMoney {
                amount
              }
            }
            discountedUnitPriceSet {
              shopMoney {
                amount
              }
            }
          }
        }
      }
    }
  }
`;

const RETURNABLE_FULFILLMENTS_QUERY = `#graphql
  query ReturnableFulfillmentsForOrder($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 50) {
      nodes {
        returnableFulfillmentLineItems(first: 50) {
          nodes {
            quantity
            fulfillmentLineItem {
              id
              lineItem {
                id
                title
                variantTitle
                discountedUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                image {
                  url
                }
                product {
                  id
                }
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

function normalizeOrderNameForSearch(rawOrderNumber: string): string | null {
  const trimmed = rawOrderNumber.trim().replace(/^#/, "");
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return null;
  return `#${trimmed}`;
}

/**
 * Looks up an order by number and validates it belongs to the given email/phone
 * server-side (never trust Shopify's search query alone for identity matching).
 * Returns null on any mismatch so callers can emit one generic "not found" error.
 */
export async function findOrderForReturnLookup(
  admin: AdminApiContext,
  { orderNumber, email, phone }: { orderNumber: string; email?: string; phone?: string },
): Promise<OrderLookupResult | null> {
  const searchName = normalizeOrderNameForSearch(orderNumber);
  if (!searchName) return null;

  const response = await admin.graphql(ORDER_SEARCH_QUERY, {
    variables: { query: `name:${searchName}` },
  });
  const json: any = await response.json();
  if (json?.errors) {
    console.log("[shopify-admin] GraphQL errors on order search:", JSON.stringify(json.errors));
  }
  const order = json?.data?.orders?.nodes?.[0];
  console.log(
    "[shopify-admin] order search query:",
    `name:${searchName}`,
    "-> found order?",
    Boolean(order),
    order ? { id: order.id, name: order.name, email: order.email, phone: order.phone } : null,
  );
  if (!order) return null;

  const normalizedEmail = email?.trim().toLowerCase();
  const normalizedPhone = phone?.replace(/[^0-9]/g, "");
  const orderEmail = order.email?.trim().toLowerCase();
  const orderPhone = order.phone?.replace(/[^0-9]/g, "");

  const emailMatches = Boolean(
    normalizedEmail && orderEmail && normalizedEmail === orderEmail,
  );
  const phoneMatches = Boolean(
    normalizedPhone &&
      orderPhone &&
      normalizedPhone.length >= 7 &&
      orderPhone.endsWith(normalizedPhone.slice(-7)),
  );

  console.log("[shopify-admin] identity check", {
    normalizedEmail,
    orderEmail,
    emailMatches,
    normalizedPhone,
    orderPhone,
    phoneMatches,
  });

  if (!emailMatches && !phoneMatches) return null;

  const discountApplications: DiscountApplicationSummary[] = (
    order.discountApplications?.nodes ?? []
  ).map((node: any) => ({
    title: node.title ?? node.code ?? "Discount",
    code: node.code ?? null,
    kind:
      node.__typename === "AutomaticDiscountApplication"
        ? "AUTOMATIC"
        : node.__typename === "DiscountCodeApplication"
          ? "CODE"
          : node.__typename === "ManualDiscountApplication"
            ? "MANUAL"
            : node.__typename === "ScriptDiscountApplication"
              ? "SCRIPT"
              : "OTHER",
  }));

  const returnableItems = await getReturnableItems(admin, order.id);

  const allLineItems: OrderLineItemForDiscount[] = (order.lineItems?.nodes ?? []).map((node: any) => ({
    lineItemId: node.id,
    productId: node.product?.id ?? null,
    quantity: node.quantity,
    originalUnitPrice: node.originalUnitPriceSet?.shopMoney?.amount ?? "0.00",
    discountedUnitPrice: node.discountedUnitPriceSet?.shopMoney?.amount ?? "0.00",
  }));

  return {
    id: order.id,
    name: order.name,
    email: order.email ?? null,
    phone: order.phone ?? null,
    createdAt: order.createdAt,
    discountApplications,
    returnableItems,
    allLineItems,
  };
}

/**
 * Sources eligible items from Shopify's own returnableFulfillments
 * computation rather than raw line items, so already-fully-returned items
 * are excluded automatically. This does NOT exclude "final sale" products
 * -- confirmed via Shopify's own dev community that returnableFulfillments
 * mirrors staff permissions (who CAN return final-sale items), not the
 * customer-facing return-rules restriction, and that restriction isn't
 * exposed via the Admin API at all. Each item's productId is included here
 * so the caller can cross-reference it against this app's own
 * ReturnExclusion list instead (see getExcludedProductIds).
 */
async function getReturnableItems(
  admin: AdminApiContext,
  orderId: string,
): Promise<ReturnableItem[]> {
  const response = await admin.graphql(RETURNABLE_FULFILLMENTS_QUERY, {
    variables: { orderId },
  });
  const json = await response.json();
  const fulfillments = json?.data?.returnableFulfillments?.nodes ?? [];

  const items: ReturnableItem[] = [];
  for (const fulfillment of fulfillments) {
    for (const node of fulfillment.returnableFulfillmentLineItems?.nodes ?? []) {
      const lineItem = node.fulfillmentLineItem?.lineItem;
      if (!lineItem || node.quantity <= 0) continue;
      items.push({
        fulfillmentLineItemId: node.fulfillmentLineItem.id,
        lineItemId: lineItem.id,
        title: lineItem.title,
        variantTitle: lineItem.variantTitle ?? null,
        quantity: node.quantity,
        unitPrice: lineItem.discountedUnitPriceSet?.shopMoney?.amount ?? "0.00",
        currencyCode: lineItem.discountedUnitPriceSet?.shopMoney?.currencyCode ?? "USD",
        imageUrl: lineItem.image?.url ?? null,
        productId: lineItem.product?.id ?? null,
        tagCandidates: (lineItem.customAttributes ?? []).flatMap((attr: any) => [
          attr.key,
          attr.value,
          `${attr.key}: ${attr.value}`,
        ]),
      });
    }
  }
  return items;
}
