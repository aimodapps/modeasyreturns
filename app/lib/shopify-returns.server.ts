import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

// Our custom reason codes don't map cleanly onto Shopify's fixed ReturnReason
// enum -- this is best-effort categorization for Shopify's own reporting;
// the real reason text always travels separately as returnReasonNote.
const RETURN_REASON_MAP: Record<string, string> = {
  defective_product: "DEFECTIVE",
  broken_during_transit: "DEFECTIVE",
  doesnt_like_fragrance: "UNWANTED",
  doesnt_smell_like_original: "NOT_AS_DESCRIBED",
};

function mapReturnReason(code: string | undefined): string {
  return (code && RETURN_REASON_MAP[code]) ?? "OTHER";
}

const RETURN_CREATE_MUTATION = `#graphql
  mutation CreateShopifyReturn($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return {
        id
        name
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type ReturnLineItemForShopify = {
  fulfillmentLineItemId: string;
  quantity: number;
  reasonCode: string | undefined;
  reasonLabel: string | undefined;
};

export type ExchangeLineItemForShopify = {
  variantId: string;
  quantity: number;
};

/**
 * Creates ONE Shopify Return covering both the items being physically
 * returned and, when present, the replacement item(s) for an exchange --
 * exchangeLineItems keep the exchange on the *same* order (Shopify creates
 * on-hold fulfillment orders for them) instead of a disconnected draft order.
 * returnShippingFee is purely descriptive on the Return record; the actual
 * money movement still happens later via createShopifyRefund/sendOrderInvoice.
 */
export async function createShopifyReturn(
  admin: AdminApiContext,
  {
    orderId,
    lineItems,
    exchangeLineItems,
    returnShippingFee,
  }: {
    orderId: string;
    lineItems: ReturnLineItemForShopify[];
    exchangeLineItems: ExchangeLineItemForShopify[];
    returnShippingFee: { amount: string; currencyCode: string } | null;
  },
): Promise<{ ok: true; returnId: string; returnName: string } | { ok: false; error: string }> {
  const returnInput: Record<string, unknown> = {
    orderId,
    notifyCustomer: true,
    returnLineItems: lineItems.map((li) => ({
      fulfillmentLineItemId: li.fulfillmentLineItemId,
      quantity: li.quantity,
      returnReason: mapReturnReason(li.reasonCode),
      returnReasonNote: li.reasonLabel ?? undefined,
    })),
  };

  if (exchangeLineItems.length > 0) {
    returnInput.exchangeLineItems = exchangeLineItems.map((li) => ({
      variantId: li.variantId,
      quantity: li.quantity,
    }));
  }

  if (returnShippingFee) {
    returnInput.returnShippingFee = {
      amount: { amount: returnShippingFee.amount, currencyCode: returnShippingFee.currencyCode },
    };
  }

  const response = await admin.graphql(RETURN_CREATE_MUTATION, { variables: { returnInput } });
  const json: any = await response.json();
  const errors = json?.data?.returnCreate?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  const created = json?.data?.returnCreate?.return;
  if (!created) {
    return { ok: false, error: "Shopify did not return a created return object." };
  }

  return { ok: true, returnId: created.id, returnName: created.name };
}

const RETURN_FOR_PROCESSING_QUERY = `#graphql
  query ReturnForProcessing($returnId: ID!) {
    return(id: $returnId) {
      id
      order {
        id
        fulfillmentOrders(first: 5) {
          nodes {
            assignedLocation {
              location {
                id
              }
            }
          }
        }
      }
      returnLineItems(first: 50) {
        nodes {
          ... on ReturnLineItem {
            id
            quantity
            fulfillmentLineItem {
              id
            }
          }
        }
      }
      exchangeLineItems(first: 50) {
        nodes {
          id
          quantity
        }
      }
      reverseFulfillmentOrders(first: 10) {
        nodes {
          lineItems(first: 50) {
            nodes {
              id
              fulfillmentLineItem {
                id
              }
            }
          }
        }
      }
    }
  }
`;

const RETURN_PROCESS_MUTATION = `#graphql
  mutation ProcessShopifyReturn($input: ReturnProcessInput!) {
    returnProcess(input: $input) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * The "mark as received & inspected" step. Confirms the physical items
 * arrived (restocking them at the order's fulfillment location) and releases
 * the hold Shopify placed on any exchange replacement item's fulfillment.
 * Does NOT move any money -- that's a separate, explicit step so an invoice
 * for an exchange balance only goes out when staff choose to send it.
 */
export async function processShopifyReturn(
  admin: AdminApiContext,
  { returnId }: { returnId: string },
): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
  const detailsResponse = await admin.graphql(RETURN_FOR_PROCESSING_QUERY, { variables: { returnId } });
  const detailsJson: any = await detailsResponse.json();
  const ret = detailsJson?.data?.return;
  if (!ret) {
    return { ok: false, error: "Couldn't load the Shopify return to process it." };
  }

  const orderId = ret.order.id;
  const locationId = ret.order.fulfillmentOrders?.nodes?.[0]?.assignedLocation?.location?.id;
  if (!locationId) {
    return { ok: false, error: "Couldn't determine a fulfillment location to restock the returned item(s) at." };
  }

  const reverseLineItemIdByFulfillmentLineItemId = new Map<string, string>();
  for (const rfo of ret.reverseFulfillmentOrders?.nodes ?? []) {
    for (const li of rfo.lineItems?.nodes ?? []) {
      if (li.fulfillmentLineItem?.id) {
        reverseLineItemIdByFulfillmentLineItemId.set(li.fulfillmentLineItem.id, li.id);
      }
    }
  }

  const returnLineItems = (ret.returnLineItems?.nodes ?? []).map((rli: any) => {
    const reverseLineItemId = reverseLineItemIdByFulfillmentLineItemId.get(rli.fulfillmentLineItem?.id);
    return {
      id: rli.id,
      quantity: rli.quantity,
      dispositions: reverseLineItemId
        ? [
            {
              reverseFulfillmentOrderLineItemId: reverseLineItemId,
              quantity: rli.quantity,
              locationId,
              dispositionType: "RESTOCKED",
            },
          ]
        : [],
    };
  });

  const exchangeLineItems = (ret.exchangeLineItems?.nodes ?? []).map((eli: any) => ({
    id: eli.id,
    quantity: eli.quantity,
  }));

  const response = await admin.graphql(RETURN_PROCESS_MUTATION, {
    variables: {
      input: {
        returnId,
        returnLineItems,
        exchangeLineItems,
        notifyCustomer: false,
      },
    },
  });
  const json: any = await response.json();
  const errors = json?.data?.returnProcess?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  if (!json?.data?.returnProcess?.return) {
    return { ok: false, error: "Shopify did not confirm the return was processed." };
  }

  return { ok: true, orderId };
}

const ORDER_BALANCE_QUERY = `#graphql
  query OrderBalance($orderId: ID!) {
    order(id: $orderId) {
      totalOutstandingSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

/** The order's current outstanding balance -- reflects the real balance Shopify created from the exchange's price difference (incl. tax), not our own guess at it. */
export async function getOrderOutstandingBalance(
  admin: AdminApiContext,
  { orderId }: { orderId: string },
): Promise<{ amount: number; currencyCode: string } | null> {
  const response = await admin.graphql(ORDER_BALANCE_QUERY, { variables: { orderId } });
  const json: any = await response.json();
  const money = json?.data?.order?.totalOutstandingSet?.presentmentMoney;
  if (!money) return null;
  return { amount: Number(money.amount), currencyCode: money.currencyCode };
}

const ORDER_ORIGINAL_TRANSACTION_QUERY = `#graphql
  query OrderOriginalTransaction($orderId: ID!) {
    order(id: $orderId) {
      currencyCode
      transactions(first: 20) {
        id
        kind
        status
        gateway
      }
    }
  }
`;

const REFUND_CREATE_MUTATION = `#graphql
  mutation CreateShopifyRefund($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {
        id
        totalRefundedSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createShopifyRefund(
  admin: AdminApiContext,
  {
    orderId,
    lineItems,
    totalAmount,
    idempotencyKey,
  }: {
    orderId: string;
    lineItems: Array<{ shopifyLineItemId: string; quantity: number }>;
    totalAmount: string;
    idempotencyKey: string;
  },
): Promise<{ ok: true; refundId: string } | { ok: false; error: string }> {
  const orderResponse = await admin.graphql(ORDER_ORIGINAL_TRANSACTION_QUERY, {
    variables: { orderId },
  });
  const orderJson: any = await orderResponse.json();
  const transactions = orderJson?.data?.order?.transactions ?? [];
  const original = transactions.find(
    (t: any) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS",
  );

  if (!original) {
    return {
      ok: false,
      error: "Couldn't find the order's original payment transaction to refund against.",
    };
  }

  const response = await admin.graphql(REFUND_CREATE_MUTATION, {
    variables: {
      idempotencyKey,
      input: {
        orderId,
        notify: true,
        refundLineItems: lineItems.map((li) => ({
          lineItemId: li.shopifyLineItemId,
          quantity: li.quantity,
        })),
        transactions: [
          {
            orderId,
            parentId: original.id,
            gateway: original.gateway,
            kind: "REFUND",
            amount: totalAmount,
          },
        ],
      },
    },
  });
  const json: any = await response.json();
  const errors = json?.data?.refundCreate?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  const refund = json?.data?.refundCreate?.refund;
  if (!refund) {
    return { ok: false, error: "Shopify did not return a created refund object." };
  }

  return { ok: true, refundId: refund.id };
}

const ORDER_INVOICE_SEND_MUTATION = `#graphql
  mutation SendOrderInvoice($id: ID!, $email: EmailInput) {
    orderInvoiceSend(id: $id, email: $email) {
      order {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

/** Manually triggered (never automatic) once staff have received & inspected the return -- sends Shopify's own invoice email with a payment link for the exchange's outstanding balance. */
export async function sendOrderInvoice(
  admin: AdminApiContext,
  { orderId, to, customMessage }: { orderId: string; to?: string | null; customMessage?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await admin.graphql(ORDER_INVOICE_SEND_MUTATION, {
    variables: {
      id: orderId,
      email: to ? { to, customMessage: customMessage ?? undefined } : undefined,
    },
  });
  const json: any = await response.json();
  const errors = json?.data?.orderInvoiceSend?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  return { ok: true };
}
