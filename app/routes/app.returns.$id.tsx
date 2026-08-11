import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  TextField,
  Banner,
  Thumbnail,
  Link as PolarisLink,
} from "@shopify/polaris";
import { useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { computeReturnRefundBreakdown } from "../lib/return-refund.server";
import {
  createShopifyReturn,
  createShopifyRefund,
  processShopifyReturn,
  getOrderOutstandingBalance,
  getExchangeFulfillmentStatus,
  sendOrderInvoice,
} from "../lib/shopify-returns.server";
import { getReturnPhotoUrls } from "../lib/photo-upload.server";
import { sendReturnApprovedEmail, sendReturnDeniedEmail, sendReturnReceivedEmail } from "../lib/email.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const returnRequest = await db.returnRequest.findFirst({
    where: { id: params.id!, shopDomain: session.shop },
    include: {
      lineItems: { include: { conditionOption: true, reason: true, exchangeSelection: true } },
      photos: true,
      notifications: { orderBy: { sentAt: "desc" } },
    },
  });
  if (!returnRequest) throw new Response("Not found", { status: 404 });

  const { byLineItemId } = await computeReturnRefundBreakdown(returnRequest);
  const refundBreakdown = Object.fromEntries(byLineItemId);

  const targetVariantIds = returnRequest.lineItems
    .map((li) => li.exchangeSelection?.targetVariantId)
    .filter((id): id is string => Boolean(id));
  const hasExchange = targetVariantIds.length > 0;

  let exchangeFulfillmentStatus: string | null = null;
  if (returnRequest.status === "APPROVED" && hasExchange) {
    try {
      exchangeFulfillmentStatus = await getExchangeFulfillmentStatus(admin, {
        orderId: returnRequest.orderId,
        targetVariantIds,
      });
    } catch (error) {
      console.error("[app.returns.$id] failed to fetch live exchange fulfillment status", error);
    }
  }

  let photoUrls: Record<string, string | null> = {};
  if (returnRequest.photos.length > 0) {
    try {
      photoUrls = await getReturnPhotoUrls(admin, returnRequest.photos.map((p) => p.shopifyFileId));
    } catch (error) {
      console.error("[app.returns.$id] failed to fetch photo preview URLs", error);
    }
  }

  return { returnRequest, refundBreakdown, hasExchange, exchangeFulfillmentStatus, photoUrls };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const returnRequest = await db.returnRequest.findFirst({
    where: { id: params.id!, shopDomain: session.shop },
    include: { lineItems: { include: { exchangeSelection: true, reason: true } } },
  });
  if (!returnRequest) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "deny") {
    const note = String(formData.get("note") ?? "").trim() || null;
    await db.returnRequest.update({
      where: { id: returnRequest.id },
      data: { status: "DENIED", decidedAt: new Date(), adminNote: note },
    });
    if (returnRequest.customerEmail) {
      await sendReturnDeniedEmail({
        returnRequestId: returnRequest.id,
        customerEmail: returnRequest.customerEmail,
        orderName: returnRequest.orderName,
        note,
      }).catch((error) => console.error("[app.returns] failed to send denial email", error));
    }
    return { ok: true };
  }

  if (intent === "approve") {
    const currencyCode = returnRequest.lineItems[0]?.currencyCode ?? "USD";

    const exchangeLineItems = returnRequest.lineItems
      .filter((li) => li.exchangeSelection)
      .map((li) => ({ variantId: li.exchangeSelection!.targetVariantId, quantity: li.quantity }));

    const feeAmount = returnRequest.shippingFeeAmount != null ? Number(returnRequest.shippingFeeAmount) : 0;

    const returnResult = await createShopifyReturn(admin, {
      orderId: returnRequest.orderId,
      lineItems: returnRequest.lineItems.map((li) => ({
        fulfillmentLineItemId: li.fulfillmentLineItemId,
        quantity: li.quantity,
        reasonCode: undefined,
        reasonLabel: li.reason?.label,
      })),
      exchangeLineItems,
      returnShippingFee: feeAmount > 0 ? { amount: feeAmount.toFixed(2), currencyCode } : null,
    });

    if (!returnResult.ok) {
      return { ok: false, error: `Couldn't create the Shopify return: ${returnResult.error}` };
    }

    await db.returnRequest.update({
      where: { id: returnRequest.id },
      data: {
        status: "APPROVED",
        decidedAt: new Date(),
        shopifyReturnId: returnResult.returnId,
        shopifyReturnName: returnResult.returnName,
        lifecycleStage: "AWAITING_RECEIPT",
        adminNote: null,
      },
    });

    if (returnRequest.customerEmail) {
      await sendReturnApprovedEmail({
        returnRequestId: returnRequest.id,
        customerEmail: returnRequest.customerEmail,
        orderName: returnRequest.orderName,
      }).catch((error) => console.error("[app.returns] failed to send approval email", error));
    }

    return { ok: true };
  }

  if (intent === "markReceived") {
    if (!returnRequest.shopifyReturnId) {
      return { ok: false, error: "This request has no Shopify return to process yet." };
    }

    const processResult = await processShopifyReturn(admin, { returnId: returnRequest.shopifyReturnId });
    if (!processResult.ok) {
      return { ok: false, error: `Couldn't mark the return as received: ${processResult.error}` };
    }

    const { byLineItemId } = await computeReturnRefundBreakdown(returnRequest);
    const currencyCode = returnRequest.lineItems[0]?.currencyCode ?? "USD";

    // Only plain-return items get a manual refund here -- exchanged items'
    // value is netted natively by Shopify into the order's own balance
    // (read back below via getOrderOutstandingBalance), not computed by us.
    const plainReturnItems = returnRequest.lineItems.filter((li) => !li.exchangeSelection);
    let refundOnlyCents = 0;
    const refundLineItems: Array<{ shopifyLineItemId: string; quantity: number }> = [];
    for (const li of plainReturnItems) {
      const recalculated = byLineItemId.get(li.id)?.recalculatedRefund ?? Number(li.unitPrice) * li.quantity;
      refundOnlyCents += Math.round(recalculated * 100);
      refundLineItems.push({ shopifyLineItemId: li.shopifyLineItemId, quantity: li.quantity });
    }

    const feeCents = returnRequest.shippingFeeAmount != null ? Math.round(Number(returnRequest.shippingFeeAmount) * 100) : 0;
    // The fee only comes out of a refund we're actually issuing -- an
    // exchange-only fee is expected to already be netted by Shopify via the
    // returnShippingFee we set at approval time.
    const netRefundCents = plainReturnItems.length > 0 ? Math.max(0, refundOnlyCents - feeCents) : 0;

    let refundId: string | null = null;
    if (netRefundCents > 0) {
      const refundResult = await createShopifyRefund(admin, {
        orderId: returnRequest.orderId,
        lineItems: refundLineItems,
        totalAmount: (netRefundCents / 100).toFixed(2),
        idempotencyKey: `${returnRequest.id}-refund`,
      });
      if (!refundResult.ok) {
        await db.returnRequest.update({
          where: { id: returnRequest.id },
          data: {
            receivedAt: new Date(),
            adminNote: `Return marked received, but the refund failed: ${refundResult.error}. Process it manually from the order.`,
          },
        });
        return {
          ok: false,
          error: `Return marked received, but the refund failed: ${refundResult.error}. You'll need to process it manually from the order.`,
        };
      }
      refundId = refundResult.refundId;
    }

    const balance = await getOrderOutstandingBalance(admin, { orderId: returnRequest.orderId });
    const balanceDue = balance && balance.amount > 0.005 ? balance : null;

    await db.returnRequest.update({
      where: { id: returnRequest.id },
      data: {
        receivedAt: new Date(),
        lifecycleStage: balanceDue ? "BALANCE_DUE" : "COMPLETED",
        shopifyRefundId: refundId ?? returnRequest.shopifyRefundId,
        refundIssuedAmount: netRefundCents > 0 ? netRefundCents / 100 : null,
        balanceDueAmount: balanceDue ? balanceDue.amount : null,
        balanceDueCurrency: balanceDue ? balanceDue.currencyCode : null,
        adminNote: null,
      },
    });

    if (returnRequest.customerEmail) {
      await sendReturnReceivedEmail({
        returnRequestId: returnRequest.id,
        customerEmail: returnRequest.customerEmail,
        orderName: returnRequest.orderName,
        refundIssuedAmount: netRefundCents > 0 ? netRefundCents / 100 : null,
        currencyCode,
        balanceDueAmount: balanceDue ? balanceDue.amount : null,
      }).catch((error) => console.error("[app.returns] failed to send received email", error));
    }

    return { ok: true };
  }

  if (intent === "sendInvoice") {
    const invoiceResult = await sendOrderInvoice(admin, {
      orderId: returnRequest.orderId,
      to: returnRequest.customerEmail,
    });
    if (!invoiceResult.ok) {
      return { ok: false, error: `Couldn't send the invoice: ${invoiceResult.error}` };
    }

    await db.returnRequest.update({
      where: { id: returnRequest.id },
      data: { lifecycleStage: "INVOICE_SENT", invoiceSentAt: new Date() },
    });
    if (returnRequest.customerEmail) {
      await db.adminNotificationLog.create({
        data: {
          returnRequestId: returnRequest.id,
          type: "RETURN_RECEIVED",
          recipientEmail: returnRequest.customerEmail,
          provider: "shopify",
          status: "SENT",
          errorMessage: "Invoice email sent via Shopify orderInvoiceSend.",
        },
      });
    }

    return { ok: true };
  }

  return { ok: false, error: "Unknown action." };
};

const STAGE_LABELS: Record<string, string> = {
  AWAITING_RECEIPT: "Waiting for return to be received and inspected",
  BALANCE_DUE: "Received & inspected -- balance due",
  INVOICE_SENT: "Invoice sent (Awaiting Payment)",
  COMPLETED: "Completed",
};

// FulfillmentOrder.status values, mapped to what the exchange step should say.
function exchangeShippedLabel(status: string | null): { label: string; done: boolean } {
  switch (status) {
    case "CLOSED":
      return { label: "Exchange Shipped", done: true };
    case "ON_HOLD":
      return { label: "Exchange on hold -- awaiting return receipt", done: false };
    case "CANCELLED":
      return { label: "Exchange cancelled", done: false };
    case "OPEN":
    case "IN_PROGRESS":
    case "SCHEDULED":
      return { label: "Exchange ready -- preparing for shipment", done: false };
    default:
      return { label: "Preparing exchange for shipment", done: false };
  }
}

function LifecycleStepper({
  lifecycleStage,
  hasExchange,
  balanceDueAmount,
  balanceDueCurrency,
  exchangeFulfillmentStatus,
}: {
  lifecycleStage: string | null;
  hasExchange: boolean;
  balanceDueAmount: unknown;
  balanceDueCurrency: string | null;
  exchangeFulfillmentStatus: string | null;
}) {
  const order = ["AWAITING_RECEIPT", "BALANCE_DUE", "INVOICE_SENT", "COMPLETED"];
  const currentIndex = lifecycleStage ? order.indexOf(lifecycleStage) : -1;

  const steps: Array<{ key: string; label: string }> = [{ key: "ACCEPTED", label: "Return/Exchange Accepted" }];
  steps.push({ key: "AWAITING_RECEIPT", label: "Waiting for return to be received and inspected" });
  if (balanceDueAmount != null || lifecycleStage === "BALANCE_DUE" || lifecycleStage === "INVOICE_SENT") {
    steps.push({ key: "INVOICE_SENT", label: "Invoice sent (Awaiting Payment)" });
  }
  steps.push({ key: "COMPLETED", label: "Completed" });

  return (
    <BlockStack gap="200">
      <Text as="h2" variant="headingMd">
        Status
      </Text>
      <BlockStack gap="150">
        {steps.map((step) => {
          const stepIndex = step.key === "ACCEPTED" ? 0 : step.key === "INVOICE_SENT" ? order.indexOf("BALANCE_DUE") : order.indexOf(step.key);
          const isCurrent =
            step.key === "ACCEPTED"
              ? currentIndex === -1
              : step.key === "INVOICE_SENT"
                ? lifecycleStage === "BALANCE_DUE" || lifecycleStage === "INVOICE_SENT"
                : lifecycleStage === step.key;
          const isDone = step.key === "ACCEPTED" ? currentIndex >= 0 : currentIndex > stepIndex || (step.key === "INVOICE_SENT" && lifecycleStage === "COMPLETED");
          return (
            <InlineStack key={step.key} gap="200" blockAlign="center">
              <Badge tone={isDone ? "success" : isCurrent ? "attention" : undefined}>
                {isDone ? "Done" : isCurrent ? "Current" : "Pending"}
              </Badge>
              <Text as="span">
                {step.key === "INVOICE_SENT" && lifecycleStage === "INVOICE_SENT"
                  ? STAGE_LABELS.INVOICE_SENT
                  : step.label}
              </Text>
            </InlineStack>
          );
        })}
        {hasExchange &&
          (() => {
            const { label, done } = exchangeShippedLabel(exchangeFulfillmentStatus);
            return (
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={done ? "success" : undefined}>{done ? "Done" : "Pending"}</Badge>
                <Text as="span">{label}</Text>
              </InlineStack>
            );
          })()}
      </BlockStack>
      {balanceDueAmount != null && (
        <Text as="p" tone="caution">
          Customer owes {Number(balanceDueAmount).toFixed(2)} {balanceDueCurrency}.
        </Text>
      )}
    </BlockStack>
  );
}

export default function ReturnDetail() {
  const { returnRequest, refundBreakdown, hasExchange, exchangeFulfillmentStatus, photoUrls } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [denyNote, setDenyNote] = useState("");

  const canDecide = returnRequest.status === "PENDING_REVIEW";
  const canMarkReceived = returnRequest.status === "APPROVED" && returnRequest.lifecycleStage === "AWAITING_RECEIPT";
  const canSendInvoice = returnRequest.status === "APPROVED" && returnRequest.lifecycleStage === "BALANCE_DUE";

  return (
    <Page backAction={{ url: "/app/returns" }}>
      <TitleBar title={`Return -- ${returnRequest.orderName}`} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {returnRequest.adminNote && (
              <Banner tone={returnRequest.status === "DENIED" ? "critical" : "warning"}>
                {returnRequest.adminNote}
              </Banner>
            )}

            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    {returnRequest.orderName}
                  </Text>
                  <Badge
                    tone={
                      returnRequest.status === "APPROVED"
                        ? "success"
                        : returnRequest.status === "DENIED"
                          ? "critical"
                          : "attention"
                    }
                  >
                    {returnRequest.status.replace("_", " ")}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {returnRequest.customerEmail ?? "No email"} · {returnRequest.customerPhone ?? "No phone"}
                </Text>
                {returnRequest.shopifyReturnName && (
                  <Text as="p" tone="subdued">
                    Shopify return: {returnRequest.shopifyReturnName}
                  </Text>
                )}
              </BlockStack>
            </Card>

            {returnRequest.status === "APPROVED" && (
              <Card>
                <LifecycleStepper
                  lifecycleStage={returnRequest.lifecycleStage}
                  hasExchange={hasExchange}
                  balanceDueAmount={returnRequest.balanceDueAmount}
                  balanceDueCurrency={returnRequest.balanceDueCurrency}
                  exchangeFulfillmentStatus={exchangeFulfillmentStatus}
                />
              </Card>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Items
                </Text>
                {returnRequest.lineItems.map((item) => {
                  const reallocation = refundBreakdown[item.id];
                  const naiveRefund = Number(item.unitPrice) * item.quantity;
                  return (
                    <BlockStack key={item.id} gap="100">
                      <Text as="p" fontWeight="semibold">
                        {item.title}
                        {item.variantTitle ? ` — ${item.variantTitle}` : ""} × {item.quantity}
                      </Text>
                      <Text as="p" tone="subdued">
                        Condition: {item.conditionOption?.label ?? "—"} · Reason: {item.reason?.label ?? "—"}
                      </Text>
                      {item.exchangeSelection ? (
                        <Text as="p">
                          Exchange for {item.exchangeSelection.targetTitle}
                          {item.exchangeSelection.targetVariantTitle
                            ? ` — ${item.exchangeSelection.targetVariantTitle}`
                            : ""}{" "}
                          ({item.exchangeSelection.direction}{" "}
                          {item.exchangeSelection.priceDifference.toString()} {item.exchangeSelection.currencyCode})
                        </Text>
                      ) : (
                        <Text as="p">
                          Refund: {(reallocation?.recalculatedRefund ?? naiveRefund).toFixed(2)} {item.currencyCode}
                          {reallocation?.stillQualifies === false && (
                            <Text as="span" tone="caution">
                              {" "}
                              (discount reallocated -- {reallocation.note})
                            </Text>
                          )}
                        </Text>
                      )}
                    </BlockStack>
                  );
                })}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Photos
                </Text>
                {returnRequest.photos.length === 0 && <Text as="p" tone="subdued">None uploaded.</Text>}
                <InlineStack gap="300">
                  {returnRequest.photos.map((photo) => {
                    const url = photoUrls[photo.shopifyFileId];
                    const label = photo.originalFilename ?? photo.shopifyFileId;
                    return (
                      <BlockStack key={photo.id} gap="100" align="center">
                        {url && (
                          <PolarisLink url={url} target="_blank">
                            <Thumbnail source={url} alt={label} size="large" />
                          </PolarisLink>
                        )}
                        {url ? (
                          <PolarisLink url={url} target="_blank">
                            {label}
                          </PolarisLink>
                        ) : (
                          <Text as="span" tone="subdued">
                            {label} (still processing)
                          </Text>
                        )}
                      </BlockStack>
                    );
                  })}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Shipping
                </Text>
                <Text as="p">
                  {returnRequest.shippingMethod === "RETURN_LABEL" ? "Return label requested" : "Customer's own carrier"}
                  {" — "}
                  {returnRequest.shippingFeeAmount?.toString() ?? "0.00"} fee
                </Text>
                {returnRequest.refundIssuedAmount != null && (
                  <Text as="p" tone="subdued">
                    Refund issued: {returnRequest.refundIssuedAmount.toString()}
                  </Text>
                )}
              </BlockStack>
            </Card>

            {canDecide && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Decision
                  </Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="approve" />
                    <Button variant="primary" submit loading={isSubmitting}>
                      Approve
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="deny" />
                    <BlockStack gap="200">
                      <TextField
                        label="Reason for denial (optional, sent to customer)"
                        name="note"
                        value={denyNote}
                        onChange={setDenyNote}
                        multiline={2}
                        autoComplete="off"
                      />
                      <Button tone="critical" submit loading={isSubmitting}>
                        Deny
                      </Button>
                    </BlockStack>
                  </Form>
                </BlockStack>
              </Card>
            )}

            {canMarkReceived && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Next step
                  </Text>
                  <Text as="p" tone="subdued">
                    Once the physical item(s) arrive and have been inspected, confirm receipt to restock inventory,
                    release the exchange replacement for fulfillment, and issue any refund due.
                  </Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="markReceived" />
                    <Button variant="primary" submit loading={isSubmitting}>
                      Mark received & inspected
                    </Button>
                  </Form>
                </BlockStack>
              </Card>
            )}

            {canSendInvoice && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Next step
                  </Text>
                  <Text as="p" tone="subdued">
                    The exchange has a remaining balance of {returnRequest.balanceDueAmount?.toString()}{" "}
                    {returnRequest.balanceDueCurrency}. Send the customer an invoice with a payment link when you're
                    ready to collect it.
                  </Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="sendInvoice" />
                    <Button variant="primary" submit loading={isSubmitting}>
                      Send invoice
                    </Button>
                  </Form>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
