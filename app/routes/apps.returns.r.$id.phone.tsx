import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";
import { getPortalBranding } from "../lib/portal-branding.server";
import { PortalLogo } from "../components/PortalLogo";

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

  const branding = await getPortalBranding(session.shop);
  return { returnRequest, branding };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const returnContactPhone = String(formData.get("returnContactPhone") ?? "").trim();

  await db.returnRequest.update({
    where: { id: returnRequest.id },
    data: { returnContactPhone: returnContactPhone || null },
  });

  return redirect(`/apps/returns/r/${returnRequest.id}/refund-method`);
};

export default function PhoneStep() {
  const { returnRequest, branding } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <PortalLogo logoUrl={branding.logoUrl} logoWidthPx={branding.logoWidthPx} />
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>What's the best phone number for pickup?</h1>
        <p style={styles.subheading}>
          Some return carriers require a phone number to schedule pickup or delivery. Optional, but
          adding one can help avoid delays.
        </p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/phone`} style={styles.form}>
          <label style={styles.label}>
            Phone number (optional)
            <input
              style={styles.input}
              type="tel"
              name="returnContactPhone"
              placeholder="(555) 555-5555"
              defaultValue={returnRequest.returnContactPhone ?? returnRequest.customerPhone ?? ""}
            />
          </label>

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Continue"}
          </button>
        </Form>
      </div>
    </div>
  );
}
