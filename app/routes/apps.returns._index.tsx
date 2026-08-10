import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { isRateLimited } from "../lib/rate-limit.server";
import {
  performOrderLookup,
  GENERIC_NOT_FOUND_MESSAGE,
  type OrderLookupResponse,
} from "../lib/order-lookup.server";
import type { ReturnableItem } from "../lib/shopify-admin.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return null;
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

  const result = await performOrderLookup(admin, session.shop, {
    orderNumber,
    email: isEmail ? contact : undefined,
    phone: isEmail ? undefined : contact,
  });

  return Response.json(result);
}

export default function ReturnsPortal() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.heading}>Start a return or exchange</h1>
        <p style={styles.subheading}>
          Enter your order number and the email or phone number used at checkout.
        </p>

        <Form method="post" action="/apps/returns" style={styles.form}>
          <label style={styles.label}>
            Order number
            <input
              style={styles.input}
              type="text"
              name="orderNumber"
              placeholder="#1001"
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

        {actionData?.eligible && (
          <div style={styles.results}>
            <h2 style={styles.resultsHeading}>Order {actionData.order.name}</h2>
            <ul style={styles.itemList}>
              {actionData.items.map((item: ReturnableItem) => (
                <li key={item.fulfillmentLineItemId} style={styles.item}>
                  <span>
                    {item.title}
                    {item.variantTitle ? ` — ${item.variantTitle}` : ""}
                  </span>
                  <span>
                    Qty {item.quantity} · {item.unitPrice} {item.currencyCode}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: "#f6f5f3",
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    padding: "48px 16px",
  },
  card: {
    background: "#ffffff",
    borderRadius: 16,
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    padding: 32,
    maxWidth: 480,
    width: "100%",
  },
  heading: { fontSize: 24, margin: "0 0 8px", color: "#1a1a1a" },
  subheading: { fontSize: 14, color: "#6b6b6b", margin: "0 0 24px" },
  form: { display: "flex", flexDirection: "column", gap: 16 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#333" },
  input: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #d9d9d9",
    fontSize: 15,
  },
  button: {
    marginTop: 8,
    padding: "12px 16px",
    borderRadius: 8,
    border: "none",
    background: "#1a1a1a",
    color: "#fff",
    fontSize: 15,
    cursor: "pointer",
  },
  error: {
    marginTop: 20,
    color: "#b3261e",
    fontSize: 14,
  },
  results: { marginTop: 24 },
  resultsHeading: { fontSize: 16, margin: "0 0 12px" },
  itemList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 },
  item: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 14,
    borderBottom: "1px solid #eee",
    paddingBottom: 10,
  },
};
