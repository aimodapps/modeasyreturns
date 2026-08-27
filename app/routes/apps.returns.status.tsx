import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isRateLimited } from "../lib/rate-limit.server";
import { findOrderForReturnLookup } from "../lib/shopify-admin.server";
import { GENERIC_NOT_FOUND_MESSAGE } from "../lib/order-lookup.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";
import { getPortalBranding } from "../lib/portal-branding.server";
import { PortalLogo } from "../components/PortalLogo";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const prefillOrderNumber = url.searchParams.get("order") ?? "";

  try {
    const { session } = await authenticate.public.appProxy(request);
    const branding = session ? await getPortalBranding(session.shop) : null;
    return { prefillOrderNumber, branding };
  } catch (error) {
    if (error instanceof Response) throw error;
    // Same full-page server-rendered POST situation as apps.returns._index
    // -- an unguarded throw here would crash the whole request into a raw
    // 500 even when the action itself succeeded.
    console.error("[apps.returns.status] loader failed", error);
    return { prefillOrderNumber, branding: null };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    return await handleAction(request);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[apps.returns.status] unhandled error", error);
    return { error: GENERIC_NOT_FOUND_MESSAGE };
  }
};

async function handleAction(request: Request) {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return { error: GENERIC_NOT_FOUND_MESSAGE };
  }

  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(`return-status:${session.shop}:${clientIp}`, { max: 10, windowMs: 5 * 60 * 1000 })) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  const formData = await request.formData();
  const orderNumber = String(formData.get("orderNumber") ?? "");
  const contact = String(formData.get("contact") ?? "");
  const isEmail = contact.includes("@");
  const email = isEmail ? contact : undefined;
  const phone = isEmail ? undefined : contact;

  if (!orderNumber.trim() || !contact.trim()) {
    return { error: "Please provide your order number and either an email or phone number." };
  }

  const order = await findOrderForReturnLookup(admin, { orderNumber, email, phone });
  if (!order) {
    return { error: GENERIC_NOT_FOUND_MESSAGE };
  }

  const existing = await db.returnRequest.findFirst({
    where: { shopDomain: session.shop, orderId: order.id, status: { not: "DRAFT" } },
    orderBy: { createdAt: "desc" },
  });

  if (!existing) {
    return { error: "We couldn't find a submitted return or exchange request for this order." };
  }

  return redirect(`/apps/returns/r/${existing.id}/summary`);
}

export default function ReturnStatusLookup() {
  const { prefillOrderNumber, branding } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <PortalLogo logoUrl={branding?.logoUrl ?? null} logoWidthPx={branding?.logoWidthPx ?? null} />
        <h1 style={styles.heading}>Check your return status</h1>
        <p style={styles.subheading}>
          Enter your order number and the email or phone number used at checkout to see the latest status of your
          return or exchange.
        </p>

        <Form method="post" action="/apps/returns/status" style={styles.form}>
          <label style={styles.label}>
            Order number
            <input
              style={styles.input}
              type="text"
              name="orderNumber"
              placeholder={branding?.orderNumberPlaceholder || "#1001"}
              defaultValue={prefillOrderNumber}
              required
            />
          </label>
          <label style={styles.label}>
            Email or phone number
            <input style={styles.input} type="text" name="contact" placeholder="you@example.com" required />
          </label>
          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Searching…" : "Check status"}
          </button>
        </Form>

        {actionData?.error && <p style={styles.error}>{actionData.error}</p>}
      </div>
    </div>
  );
}
