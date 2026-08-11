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
        reverseFulfillmentOrders(first: 10) {
          nodes {
            id
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

export type ReturnLineItemForShopify = {
  fulfillmentLineItemId: string;
  quantity: number;
  reasonCode: string | undefined;
  reasonLabel: string | undefined;
};

export async function createShopifyReturn(
  admin: AdminApiContext,
  { orderId, lineItems }: { orderId: string; lineItems: ReturnLineItemForShopify[] },
): Promise<
  | { ok: true; returnId: string; returnName: string; reverseFulfillmentOrderIds: string[] }
  | { ok: false; error: string }
> {
  const response = await admin.graphql(RETURN_CREATE_MUTATION, {
    variables: {
      returnInput: {
        orderId,
        notifyCustomer: true,
        returnLineItems: lineItems.map((li) => ({
          fulfillmentLineItemId: li.fulfillmentLineItemId,
          quantity: li.quantity,
          returnReason: mapReturnReason(li.reasonCode),
          returnReasonNote: li.reasonLabel ?? undefined,
        })),
      },
    },
  });
  const json: any = await response.json();
  const errors = json?.data?.returnCreate?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  const created = json?.data?.returnCreate?.return;
  if (!created) {
    return { ok: false, error: "Shopify did not return a created return object." };
  }

  return {
    ok: true,
    returnId: created.id,
    returnName: created.name,
    reverseFulfillmentOrderIds: (created.reverseFulfillmentOrders?.nodes ?? []).map((n: any) => n.id),
  };
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
