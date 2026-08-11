import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { computeReturnRefundBreakdown } from "../lib/return-refund.server";
import { sendReturnInitiatedEmail } from "../lib/email.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });

  const returnRequest = await db.returnRequest.findFirst({
    where: { id: params.id!, shopDomain: session.shop },
    include: {
      lineItems: { include: { conditionOption: true, reason: true, exchangeSelection: true } },
      photos: true,
    },
  });
  if (!returnRequest) throw new Response("Not found", { status: 404 });

  if (returnRequest.status === "DRAFT") {
    if (returnRequest.lineItems.length === 0) {
      throw redirect(`/apps/returns/r/${returnRequest.id}/items`);
    }
    if (returnRequest.lineItems.some((li) => !li.conditionOptionId || li.conditionDenied)) {
      throw redirect(`/apps/returns/r/${returnRequest.id}/condition`);
    }
    if (returnRequest.photos.length === 0) {
      throw redirect(`/apps/returns/r/${returnRequest.id}/photo`);
    }
    if (returnRequest.lineItems.some((li) => !li.reasonId)) {
      throw redirect(`/apps/returns/r/${returnRequest.id}/reason`);
    }
    if (!returnRequest.shippingMethod) {
      throw redirect(`/apps/returns/r/${returnRequest.id}/shipping`);
    }
  }

  const { byLineItemId } = await computeReturnRefundBreakdown(returnRequest);
  const refundBreakdown = Object.fromEntries(byLineItemId);

  return { returnRequest, refundBreakdown };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });

  const returnRequest = await db.returnRequest.findFirst({
    where: { id: params.id!, shopDomain: session.shop },
    include: { lineItems: true },
  });
  if (!returnRequest) throw new Response("Not found", { status: 404 });

  if (returnRequest.status === "DRAFT") {
    await db.returnRequest.update({
      where: { id: returnRequest.id },
      data: { status: "PENDING_REVIEW", submittedAt: new Date() },
    });

    const shopSettings = await db.shopSettings.findUnique({ where: { shopDomain: session.shop } });
    // Never let an email outage block the customer's submission from
    // succeeding -- the status flip above already happened.
    if (shopSettings?.supportEmail) {
      const itemSummary = returnRequest.lineItems
        .map((li) => `${li.title}${li.variantTitle ? ` — ${li.variantTitle}` : ""} × ${li.quantity}`)
        .join(", ");
      await sendReturnInitiatedEmail({
        returnRequestId: returnRequest.id,
        adminEmail: shopSettings.supportEmail,
        orderName: returnRequest.orderName,
        customerEmail: returnRequest.customerEmail,
        itemSummary,
        reviewUrl: `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/returns/${returnRequest.id}`,
      }).catch((error) => console.error("[apps.returns] failed to send admin notification email", error));
    }
  }

  return redirect(`/apps/returns/r/${returnRequest.id}/summary`);
};

function computeNet(
  returnRequest: {
    lineItems: Array<{
      id: string;
      unitPrice: unknown;
      quantity: number;
      currencyCode: string;
      exchangeSelection: { direction: string; priceDifference: unknown } | null;
    }>;
    shippingFeeAmount: unknown;
  },
  refundBreakdown: Record<string, { recalculatedRefund: number }>,
) {
  let netCents = 0;
  for (const item of returnRequest.lineItems) {
    const sel = item.exchangeSelection;
    if (sel) {
      const diff = Number(sel.priceDifference);
      netCents +=
        sel.direction === "CHARGE" ? Math.round(diff * 100) : sel.direction === "REFUND" ? -Math.round(diff * 100) : 0;
    } else {
      const recalculated = refundBreakdown[item.id]?.recalculatedRefund;
      const refundAmount = recalculated ?? Number(item.unitPrice) * item.quantity;
      netCents -= Math.round(refundAmount * 100);
    }
  }
  if (returnRequest.shippingFeeAmount != null) {
    // A shipping/restocking fee always makes the customer's net position
    // worse -- less refund back, or more to pay on an exchange upcharge.
    netCents += Math.round(Number(returnRequest.shippingFeeAmount) * 100);
  }
  return netCents;
}

const CUSTOMER_STAGE_STEPS = [
  { key: "ACCEPTED", label: "Return/Exchange Accepted" },
  { key: "AWAITING_RECEIPT", label: "Waiting for return to be received and inspected" },
  { key: "INVOICE_SENT", label: "Invoice sent (Awaiting Payment)" },
  { key: "COMPLETED", label: "Completed" },
];

function StatusScreen({
  returnRequest,
}: {
  returnRequest: {
    id: string;
    orderName: string;
    status: string;
    lifecycleStage: string | null;
    adminNote: string | null;
    refundIssuedAmount: unknown;
    balanceDueAmount: unknown;
    balanceDueCurrency: string | null;
    lineItems: Array<{ currencyCode: string }>;
  };
}) {
  const currency = returnRequest.lineItems[0]?.currencyCode ?? "";

  if (returnRequest.status === "PENDING_REVIEW") {
    return (
      <div style={styles.page}>
        <style>{PORTAL_ANIMATION_CSS}</style>
        <div style={styles.card} className="portal-card">
          <h1 style={styles.heading}>Return request submitted</h1>
          <p style={styles.subheading}>We've notified our team. You'll hear back once it's reviewed.</p>
          <p style={{ fontSize: 14 }}>
            Reference number: <strong>{returnRequest.id.slice(-8).toUpperCase()}</strong>
          </p>
        </div>
      </div>
    );
  }

  if (returnRequest.status === "DENIED") {
    return (
      <div style={styles.page}>
        <style>{PORTAL_ANIMATION_CSS}</style>
        <div style={styles.card} className="portal-card">
          <h1 style={styles.heading}>Return request not approved</h1>
          <p style={styles.subheading}>
            {returnRequest.adminNote || "We're sorry, we're unable to approve this return request."}
          </p>
        </div>
      </div>
    );
  }

  // APPROVED -- walk the customer through the same lifecycle the admin sees.
  const showInvoiceStep =
    returnRequest.balanceDueAmount != null ||
    returnRequest.lifecycleStage === "BALANCE_DUE" ||
    returnRequest.lifecycleStage === "INVOICE_SENT";
  const steps = CUSTOMER_STAGE_STEPS.filter((s) => s.key !== "INVOICE_SENT" || showInvoiceStep);
  const order = ["AWAITING_RECEIPT", "BALANCE_DUE", "INVOICE_SENT", "COMPLETED"];
  const currentIndex = returnRequest.lifecycleStage ? order.indexOf(returnRequest.lifecycleStage) : -1;

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Your return status</h1>
        <p style={{ fontSize: 14, marginBottom: 16 }}>
          Reference number: <strong>{returnRequest.id.slice(-8).toUpperCase()}</strong>
        </p>

        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {steps.map((step) => {
            const stepIndex = step.key === "ACCEPTED" ? 0 : step.key === "INVOICE_SENT" ? order.indexOf("BALANCE_DUE") : order.indexOf(step.key);
            const isCurrent =
              step.key === "ACCEPTED"
                ? currentIndex === -1
                : step.key === "INVOICE_SENT"
                  ? returnRequest.lifecycleStage === "BALANCE_DUE" || returnRequest.lifecycleStage === "INVOICE_SENT"
                  : returnRequest.lifecycleStage === step.key;
            const isDone = step.key === "ACCEPTED" ? currentIndex >= 0 : currentIndex > stepIndex;
            return (
              <li key={step.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: isDone ? "#1a7f37" : isCurrent ? "#b38600" : "#d0d0d0",
                  }}
                />
                <span style={{ fontSize: 14, fontWeight: isCurrent ? 700 : 400, color: isCurrent ? "#1a1a1a" : "#6b6b6b" }}>
                  {step.label}
                </span>
              </li>
            );
          })}
        </ul>

        {returnRequest.balanceDueAmount != null && (
          <p style={{ fontSize: 14, marginTop: 16, fontWeight: 600 }}>
            You owe: {Number(returnRequest.balanceDueAmount).toFixed(2)} {returnRequest.balanceDueCurrency}
            {returnRequest.lifecycleStage === "INVOICE_SENT" && " — check your email for a payment link"}
          </p>
        )}
        {returnRequest.refundIssuedAmount != null && (
          <p style={{ fontSize: 14, marginTop: 8 }}>
            Refund issued: {Number(returnRequest.refundIssuedAmount).toFixed(2)} {currency}
          </p>
        )}
      </div>
    </div>
  );
}

export default function SummaryStep() {
  const { returnRequest, refundBreakdown } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (returnRequest.status !== "DRAFT") {
    return <StatusScreen returnRequest={returnRequest} />;
  }

  const netCents = computeNet(returnRequest, refundBreakdown);
  const netAmount = (Math.abs(netCents) / 100).toFixed(2);
  const currency = returnRequest.lineItems[0]?.currencyCode ?? "";

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Review your return</h1>
        <p style={styles.subheading}>Double-check everything below, then submit your request.</p>

        <ul style={styles.itemList}>
          {returnRequest.lineItems.map((item) => {
            const sel = item.exchangeSelection;
            const reallocation = refundBreakdown[item.id];
            const naiveRefund = Number(item.unitPrice) * item.quantity;
            const wasReallocated =
              reallocation &&
              reallocation.stillQualifies === false &&
              Math.abs(reallocation.recalculatedRefund - naiveRefund) > 0.005;

            return (
              <li key={item.id} style={{ ...styles.item, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                <strong>
                  {item.title}
                  {item.variantTitle ? ` — ${item.variantTitle}` : ""} × {item.quantity}
                </strong>
                <span style={{ color: "#6b6b6b", fontSize: 13 }}>
                  Condition: {item.conditionOption?.label ?? "—"}
                </span>
                <span style={{ color: "#6b6b6b", fontSize: 13 }}>Reason: {item.reason?.label ?? "—"}</span>
                {sel ? (
                  <span style={{ color: "#1a1a1a", fontSize: 13, fontWeight: 500 }}>
                    Exchange: {sel.targetTitle}
                    {sel.targetVariantTitle ? ` — ${sel.targetVariantTitle}` : ""}
                    {sel.direction === "NONE" && " (no price difference)"}
                    {sel.direction === "CHARGE" && ` (+${sel.priceDifference.toString()} ${sel.currencyCode})`}
                    {sel.direction === "REFUND" && ` (−${sel.priceDifference.toString()} ${sel.currencyCode})`}
                  </span>
                ) : (
                  <span style={{ color: "#1a1a1a", fontSize: 13, fontWeight: 500 }}>
                    Refund: {(reallocation?.recalculatedRefund ?? naiveRefund).toFixed(2)} {item.currencyCode}
                  </span>
                )}
                {wasReallocated && (
                  <span style={{ color: "#b3261e", fontSize: 12, lineHeight: 1.4 }}>{reallocation.note}</span>
                )}
              </li>
            );
          })}
        </ul>

        <p style={{ color: "#6b6b6b", fontSize: 13, marginTop: 16 }}>
          Shipping: {returnRequest.shippingMethod === "RETURN_LABEL" ? "Return label" : "Own carrier"} (
          {returnRequest.shippingFeeAmount?.toString() ?? "0.00"} {currency} fee)
        </p>
        <p style={{ color: "#6b6b6b", fontSize: 13 }}>
          ✓ {returnRequest.photos.length} photo{returnRequest.photos.length === 1 ? "" : "s"} received
        </p>

        <p style={{ fontSize: 16, fontWeight: 700, marginTop: 12 }}>
          {netCents <= 0
            ? `Estimated refund: ${netAmount} ${currency}`
            : `Estimated additional charge: ${netAmount} ${currency}`}
        </p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/summary`}>
          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Submitting…" : "Submit return request"}
          </button>
        </Form>
      </div>
    </div>
  );
}
