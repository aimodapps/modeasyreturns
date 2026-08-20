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
  try {
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
  } catch (error) {
    // admin.graphql() throws (rather than returning a normal response) for
    // protocol-level errors like a missing access scope -- caught here so a
    // Shopify-side hiccup surfaces as a clean admin-facing message instead
    // of crashing the whole action into a raw 500.
    console.error("[shopify-returns] processShopifyReturn failed", error);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Shopify request failed: ${message}` };
  }
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

const ORDER_EXCHANGE_FULFILLMENT_QUERY = `#graphql
  query OrderExchangeFulfillmentStatus($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 20) {
        nodes {
          status
          lineItems(first: 20) {
            nodes {
              lineItem {
                variant {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The order's whole-order fulfillment status is useless here -- the
 * original items were already fulfilled long before a return/exchange ever
 * happened, so it reads FULFILLED from day one regardless of the exchange
 * replacement's own progress. Instead, find the specific FulfillmentOrder
 * that Shopify created for the exchange replacement variant(s) and read
 * *its* status: ON_HOLD until the return is marked received & inspected,
 * then OPEN/IN_PROGRESS/SCHEDULED until fulfilled, then CLOSED once shipped.
 */
export async function getExchangeFulfillmentStatus(
  admin: AdminApiContext,
  { orderId, targetVariantIds }: { orderId: string; targetVariantIds: string[] },
): Promise<string | null> {
  if (targetVariantIds.length === 0) return null;
  const variantIdSet = new Set(targetVariantIds);

  const response = await admin.graphql(ORDER_EXCHANGE_FULFILLMENT_QUERY, { variables: { orderId } });
  const json: any = await response.json();
  const fulfillmentOrders = json?.data?.order?.fulfillmentOrders?.nodes ?? [];

  const match = fulfillmentOrders.find((fo: any) =>
    (fo.lineItems?.nodes ?? []).some((li: any) => variantIdSet.has(li.lineItem?.variant?.id)),
  );

  return match?.status ?? null;
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

const ORDER_CUSTOMER_QUERY = `#graphql
  query OrderCustomer($orderId: ID!) {
    order(id: $orderId) {
      customer {
        id
      }
    }
  }
`;

/** Store credit is issued against a Customer account, not an order -- guest checkouts with no account have none, and the caller needs to fall back to a cash refund in that case. */
export async function getOrderCustomerId(
  admin: AdminApiContext,
  { orderId }: { orderId: string },
): Promise<string | null> {
  const response = await admin.graphql(ORDER_CUSTOMER_QUERY, { variables: { orderId } });
  const json: any = await response.json();
  return json?.data?.order?.customer?.id ?? null;
}

const STORE_CREDIT_ACCOUNT_CREDIT_MUTATION = `#graphql
  mutation CreditStoreCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Requires the write_store_credit_account_transactions scope. Creates the customer's store credit account automatically if they don't already have one in this currency. */
export async function creditStoreCredit(
  admin: AdminApiContext,
  { customerId, amount, currencyCode }: { customerId: string; amount: string; currencyCode: string },
): Promise<{ ok: true; transactionId: string } | { ok: false; error: string }> {
  const response = await admin.graphql(STORE_CREDIT_ACCOUNT_CREDIT_MUTATION, {
    variables: {
      id: customerId,
      creditInput: { creditAmount: { amount, currencyCode } },
    },
  });
  const json: any = await response.json();
  const errors = json?.data?.storeCreditAccountCredit?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  const transaction = json?.data?.storeCreditAccountCredit?.storeCreditAccountTransaction;
  if (!transaction) {
    return { ok: false, error: "Shopify did not confirm the store credit was issued." };
  }
  return { ok: true, transactionId: transaction.id };
}

const ORDER_SHIPPING_ADDRESS_QUERY = `#graphql
  query OrderShippingAddress($orderId: ID!) {
    order(id: $orderId) {
      shippingAddress {
        address1
        address2
        city
        company
        countryCodeV2
        firstName
        lastName
        phone
        provinceCode
        zip
      }
    }
  }
`;

const ORDER_UPDATE_SHIPPING_ADDRESS_MUTATION = `#graphql
  mutation UpdateOrderShippingAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Sets the phone number on the order's existing shipping address -- some
 * return carriers require one to schedule pickup, but it isn't collected at
 * checkout. Fetches the current address first and resends it whole with only
 * phone changed, rather than trusting orderUpdate to merge a partial address
 * (that behavior isn't documented, so this never risks wiping out the real
 * street address). No-ops when the order has no shipping address at all
 * (e.g. a digital-only order).
 */
export async function updateOrderShippingPhone(
  admin: AdminApiContext,
  { orderId, phone }: { orderId: string; phone: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const addressResponse = await admin.graphql(ORDER_SHIPPING_ADDRESS_QUERY, { variables: { orderId } });
  const addressJson: any = await addressResponse.json();
  const currentAddress = addressJson?.data?.order?.shippingAddress;
  if (!currentAddress) {
    return { ok: false, error: "This order has no shipping address to add a phone number to." };
  }

  const response = await admin.graphql(ORDER_UPDATE_SHIPPING_ADDRESS_MUTATION, {
    variables: {
      input: {
        id: orderId,
        shippingAddress: {
          address1: currentAddress.address1,
          address2: currentAddress.address2,
          city: currentAddress.city,
          company: currentAddress.company,
          countryCode: currentAddress.countryCodeV2,
          firstName: currentAddress.firstName,
          lastName: currentAddress.lastName,
          phone,
          provinceCode: currentAddress.provinceCode,
          zip: currentAddress.zip,
        },
      },
    },
  });
  const json: any = await response.json();
  const errors = json?.data?.orderUpdate?.userErrors;
  if (errors?.length) {
    return { ok: false, error: errors.map((e: any) => e.message).join(", ") };
  }
  if (!json?.data?.orderUpdate?.order) {
    return { ok: false, error: "Shopify did not confirm the order's shipping address was updated." };
  }
  return { ok: true };
}
