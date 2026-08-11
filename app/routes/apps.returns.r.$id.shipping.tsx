import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
import { quoteShippingFees } from "../lib/fees.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";

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

  const refundBaseAmount = returnRequest.lineItems.reduce(
    (sum, li) => sum + Number(li.unitPrice) * li.quantity,
    0,
  );
  const itemCount = returnRequest.lineItems.reduce((sum, li) => sum + li.quantity, 0);

  const quote = await quoteShippingFees(session.shop, { refundBaseAmount, itemCount });

  return { returnRequest, quote };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const shippingMethod = formData.get("shippingMethod") === "RETURN_LABEL" ? "RETURN_LABEL" : "OWN_CARRIER";

  const refundBaseAmount = returnRequest.lineItems.reduce(
    (sum, li) => sum + Number(li.unitPrice) * li.quantity,
    0,
  );
  const itemCount = returnRequest.lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const quote = await quoteShippingFees(session.shop, { refundBaseAmount, itemCount });

  const shippingFeeAmount =
    shippingMethod === "RETURN_LABEL" ? quote.labelFeeAmount : quote.restockingFeeAmount;

  await db.returnRequest.update({
    where: { id: returnRequest.id },
    data: { shippingMethod, shippingFeeAmount },
  });

  return redirect(`/apps/returns/r/${returnRequest.id}/summary`);
};

export default function ShippingStep() {
  const { returnRequest, quote } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const currency = returnRequest.lineItems[0]?.currencyCode ?? "";

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>How would you like to ship it back?</h1>
        <p style={styles.subheading}>Choose one of the options below to continue.</p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/shipping`} style={styles.form}>
          <label style={styles.optionCard}>
            <span style={styles.optionLabel}>
              <input
                type="radio"
                name="shippingMethod"
                value="OWN_CARRIER"
                defaultChecked={returnRequest.shippingMethod !== "RETURN_LABEL"}
                required
              />
              I'll use my own carrier
            </span>
            <span style={styles.optionMessage}>
              A restocking fee of {quote.restockingFeeAmount} {currency} applies
              {quote.restockingFeeType === "PERCENTAGE" ? ` (${quote.restockingFeeValue}%)` : ""}.
            </span>
          </label>

          <label style={styles.optionCard}>
            <span style={styles.optionLabel}>
              <input
                type="radio"
                name="shippingMethod"
                value="RETURN_LABEL"
                defaultChecked={returnRequest.shippingMethod === "RETURN_LABEL"}
                required
              />
              I need a return label
            </span>
            <span style={styles.optionMessage}>
              {quote.labelFeePerItem} {currency} per item — {quote.labelFeeAmount} {currency} total for this
              return.
            </span>
          </label>

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Continue"}
          </button>
        </Form>
      </div>
    </div>
  );
}
