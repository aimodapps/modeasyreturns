import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";
import { getPortalBranding } from "../lib/portal-branding.server";
import { PortalLogo } from "../components/PortalLogo";

/** True when at least one item in the request isn't being exchanged -- that's the only part of a request that gets an actual cash-equivalent refund (exchanged items' value is netted into the order balance instead, regardless of refund method). */
async function requestHasRefundableItems(lineItemIds: string[]): Promise<boolean> {
  if (lineItemIds.length === 0) return false;
  const exchangeSelections = await db.exchangeSelection.findMany({
    where: { returnRequestLineItemId: { in: lineItemIds } },
    select: { returnRequestLineItemId: true },
  });
  const exchangedIds = new Set(exchangeSelections.map((s) => s.returnRequestLineItemId));
  return lineItemIds.some((id) => !exchangedIds.has(id));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

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

  const hasRefundableItems = await requestHasRefundableItems(returnRequest.lineItems.map((li) => li.id));
  if (!hasRefundableItems) {
    // Nothing to refund (fully exchanged) -- asking would be meaningless.
    throw redirect(`/apps/returns/r/${returnRequest.id}/summary`);
  }

  const branding = await getPortalBranding(session.shop);
  return { returnRequest, branding };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const refundMethod = formData.get("refundMethod") === "STORE_CREDIT" ? "STORE_CREDIT" : "ORIGINAL_PAYMENT_METHOD";
  if (formData.get("refundMethod") !== "STORE_CREDIT" && formData.get("refundMethod") !== "ORIGINAL_PAYMENT_METHOD") {
    return { error: "Please choose how you'd like to be refunded." };
  }

  await db.returnRequest.update({
    where: { id: returnRequest.id },
    data: { refundMethod },
  });

  return redirect(`/apps/returns/r/${returnRequest.id}/summary`);
};

export default function RefundMethodStep() {
  const { returnRequest, branding } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <PortalLogo logoUrl={branding.logoUrl} logoWidthPx={branding.logoWidthPx} />
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>How would you like to be refunded?</h1>
        <p style={styles.subheading}>
          This applies to the portion of your return that isn't being exchanged for another item.
        </p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/refund-method`} style={styles.form}>
          <label style={styles.optionCard}>
            <span style={styles.optionLabel}>
              <input
                type="radio"
                name="refundMethod"
                value="STORE_CREDIT"
                defaultChecked={returnRequest.refundMethod === "STORE_CREDIT"}
                required
              />
              Store credit
            </span>
            <span style={styles.optionMessage}>
              Issued as store credit once your return is received and inspected -- no waiting on your
              bank.
            </span>
          </label>

          <label style={styles.optionCard}>
            <span style={styles.optionLabel}>
              <input
                type="radio"
                name="refundMethod"
                value="ORIGINAL_PAYMENT_METHOD"
                defaultChecked={returnRequest.refundMethod !== "STORE_CREDIT"}
                required
              />
              Original payment method
            </span>
            <span style={styles.optionMessage}>
              Refunded to the card or payment method you originally used. Can take several business
              days to appear, depending on your bank.
            </span>
          </label>

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Continue"}
          </button>
        </Form>

        {actionData?.error && <p style={styles.error}>{actionData.error}</p>}
      </div>
    </div>
  );
}
