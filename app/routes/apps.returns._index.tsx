import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { isRateLimited } from "../lib/rate-limit.server";
import {
  performOrderLookup,
  createDraftReturnRequest,
  GENERIC_NOT_FOUND_MESSAGE,
  type OrderLookupResponse,
} from "../lib/order-lookup.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";
import { getPortalBranding } from "../lib/portal-branding.server";
import { PortalLogo } from "../components/PortalLogo";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const branding = session ? await getPortalBranding(session.shop) : null;
  // Lets a deep link (e.g. from a customer account order page) prefill the
  // order number -- the customer still has to enter a matching email/phone
  // themselves, so this doesn't weaken identity verification at all.
  return { prefillOrderNumber: url.searchParams.get("order") ?? "", branding };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    return await handleAction(request);
  } catch (error) {
    if (error instanceof Response) return error;
    // Never let an unhandled exception surface as a raw 5xx here: Shopify's
    // App Proxy replaces non-2xx upstream responses with its own themed
    // storefront error page, so a customer would see a generic Shopify error
    // instead of anything useful. Log server-side, respond with the same
    // generic message customers get for any other lookup failure.
    console.error("[apps.returns] unhandled error", error);
    return Response.json({ eligible: false, error: GENERIC_NOT_FOUND_MESSAGE } satisfies OrderLookupResponse);
  }
};

async function handleAction(request: Request) {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session) {
    return Response.json({ eligible: false, error: GENERIC_NOT_FOUND_MESSAGE } satisfies OrderLookupResponse);
  }

  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (
    isRateLimited(`order-lookup:${session.shop}:${clientIp}`, {
      max: 10,
      windowMs: 5 * 60 * 1000,
    })
  ) {
    return Response.json({
      eligible: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
    } satisfies OrderLookupResponse);
  }

  const formData = await request.formData();
  const orderNumber = String(formData.get("orderNumber") ?? "");
  const contact = String(formData.get("contact") ?? "");
  const isEmail = contact.includes("@");

  const email = isEmail ? contact : undefined;
  const phone = isEmail ? undefined : contact;

  const result = await performOrderLookup(admin, session.shop, { orderNumber, email, phone });

  if (!result.eligible) {
    return Response.json(result);
  }

  const draft = await createDraftReturnRequest(session.shop, {
    orderId: result.order.id,
    orderName: result.order.name,
    orderCreatedAt: result.order.createdAt,
    email,
    phone,
    items: result.items,
    excludedItems: result.excludedItems,
    discountApplications: result.discountApplications,
    allLineItems: result.allLineItems,
  });

  return redirect(`/apps/returns/r/${draft.id}/items`);
}

export default function ReturnsPortal() {
  const { prefillOrderNumber, branding } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <PortalLogo logoUrl={branding?.logoUrl ?? null} logoWidthPx={branding?.logoWidthPx ?? null} />
        <h1 style={styles.heading}>{branding?.pageTitle || "Start a return or exchange"}</h1>
        {branding?.introDescription ? (
          <p style={styles.subheading} dangerouslySetInnerHTML={{ __html: branding.introDescription }} />
        ) : (
          <p style={styles.subheading}>
            Enter your order number and the email or phone number used at checkout.
          </p>
        )}

        <Form method="post" action="/apps/returns" style={styles.form}>
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
            <input
              style={styles.input}
              type="text"
              name="contact"
              placeholder="you@example.com"
              required
            />
          </label>
          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Searching…" : "Find my order"}
          </button>
        </Form>

        {actionData && !actionData.eligible && (
          <p style={styles.error}>{actionData.error}</p>
        )}

        <p style={{ fontSize: 13, color: "#6b6b6b", marginTop: 24, textAlign: "center" }}>
          Already started a return or exchange?{" "}
          <a href="/apps/returns/status" style={{ color: "#1a1a1a" }}>
            Check its status
          </a>
        </p>
      </div>
    </div>
  );
}
