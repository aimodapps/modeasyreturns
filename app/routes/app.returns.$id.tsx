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
} from "@shopify/polaris";
import { useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { computeReturnRefundBreakdown } from "../lib/return-refund.server";
import { createShopifyReturn, createShopifyRefund } from "../lib/shopify-returns.server";
import { sendReturnApprovedEmail, sendReturnDeniedEmail } from "../lib/email.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

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

  return { returnRequest, refundBreakdown };
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
    const { byLineItemId } = await computeReturnRefundBreakdown(returnRequest);

    const returnResult = await createShopifyReturn(admin, {
      orderId: returnRequest.orderId,
      lineItems: returnRequest.lineItems.map((li) => ({
        fulfillmentLineItemId: li.fulfillmentLineItemId,
        quantity: li.quantity,
        reasonCode: undefined,
        reasonLabel: li.reason?.label,
      })),
    });

    if (!returnResult.ok) {
      return { ok: false, error: `Couldn't create the Shopify return: ${returnResult.error}` };
    }

    let netRefundCents = 0;
    const refundLineItems: Array<{ shopifyLineItemId: string; quantity: number }> = [];
    for (const li of returnRequest.lineItems) {
      if (li.exchangeSelection) {
        const diff = Number(li.exchangeSelection.priceDifference);
        netRefundCents += li.exchangeSelection.direction === "REFUND" ? Math.round(diff * 100) : 0;
        netRefundCents -= li.exchangeSelection.direction === "CHARGE" ? Math.round(diff * 100) : 0;
        continue;
      }
      const recalculated = byLineItemId.get(li.id)?.recalculatedRefund ?? Number(li.unitPrice) * li.quantity;
      netRefundCents += Math.round(recalculated * 100);
      refundLineItems.push({ shopifyLineItemId: li.shopifyLineItemId, quantity: li.quantity });
    }
    if (returnRequest.shippingFeeAmount != null) {
      netRefundCents -= Math.round(Number(returnRequest.shippingFeeAmount) * 100);
    }

    let refundId: string | null = null;
    if (netRefundCents > 0 && refundLineItems.length > 0) {
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
            status: "APPROVED",
            decidedAt: new Date(),
            shopifyReturnId: returnResult.returnId,
            shopifyReturnName: returnResult.returnName,
            adminNote: `Return created in Shopify, but the refund failed: ${refundResult.error}. Process the refund manually from the order.`,
          },
        });
        return {
          ok: false,
          error: `Return was created in Shopify (${returnResult.returnName}), but the refund failed: ${refundResult.error}. You'll need to process the refund manually from the order.`,
        };
      }
      refundId = refundResult.refundId;
    }

    await db.returnRequest.update({
      where: { id: returnRequest.id },
      data: {
        status: "APPROVED",
        decidedAt: new Date(),
        shopifyReturnId: returnResult.returnId,
        shopifyReturnName: returnResult.returnName,
        shopifyRefundId: refundId,
        adminNote:
          netRefundCents <= 0 && refundLineItems.length > 0
            ? "No refund was due (fees/exchange charges offset the item value) -- nothing was refunded automatically."
            : netRefundCents < 0
              ? `Customer owes an additional ${(Math.abs(netRefundCents) / 100).toFixed(2)} from the exchange price difference -- collect this manually (e.g. via a draft order invoice); it was not charged automatically.`
              : null,
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

  return { ok: false, error: "Unknown action." };
};

export default function ReturnDetail() {
  const { returnRequest, refundBreakdown } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [denyNote, setDenyNote] = useState("");

  const canDecide = returnRequest.status === "PENDING_REVIEW";

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
                <InlineStack gap="200">
                  {returnRequest.photos.map((photo) => (
                    <Text as="p" key={photo.id} tone="subdued">
                      {photo.originalFilename ?? photo.shopifyFileId} (view in Shopify Files)
                    </Text>
                  ))}
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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
