import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
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

  const reasons = await db.returnReason.findMany({
    where: { shopDomain: session.shop, isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  return { returnRequest, reasons };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const reasonId = String(formData.get("reasonId") ?? "");

  const reason = await db.returnReason.findFirst({
    where: { id: reasonId, shopDomain: session.shop },
  });

  if (!reason) {
    return { error: "Please choose a reason for your return." };
  }

  await db.returnRequestLineItem.updateMany({
    where: { returnRequestId: returnRequest.id },
    data: { reasonId: reason.id },
  });

  return redirect(`/apps/returns/r/${returnRequest.id}/summary`);
};

export default function ReasonStep() {
  const { returnRequest, reasons } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={styles.page}>
      {/* Pure-CSS reveal (no client JS required): the message is a later
          sibling of the radio input, shown only while that input is
          :checked. Works via full-page form posts too, since it's rendered
          server-side and needs no hydration. */}
      <style>{PORTAL_ANIMATION_CSS}{`
        .reason-message { display: none; margin-left: 24px; font-size: 13px; color: #6b6b6b; line-height: 1.5; white-space: pre-line; }
        .reason-option:has(.reason-radio:checked) .reason-message { display: block; }
        .reason-option:has(.reason-radio:checked) { border-color: #1a1a1a; background: #fafafa; }
      `}</style>
      <div style={styles.card} className="portal-card">
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Why are you returning this?</h1>
        <p style={styles.subheading}>Choose the reason that best matches your situation.</p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/reason`} style={styles.form}>
          {reasons.map((reason) => (
            <label key={reason.id} style={styles.optionCard} className="reason-option">
              <span style={styles.optionLabel}>
                <input type="radio" name="reasonId" value={reason.id} required className="reason-radio" />
                {reason.label}
              </span>
              <span className="reason-message">{reason.message}</span>
            </label>
          ))}

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Continue to return"}
          </button>
        </Form>

        {actionData?.error && <p style={styles.error}>{actionData.error}</p>}
      </div>
    </div>
  );
}
