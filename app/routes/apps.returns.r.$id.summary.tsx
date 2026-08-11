import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });

  const returnRequest = await db.returnRequest.findFirst({
    where: { id: params.id!, shopDomain: session.shop },
    include: { lineItems: { include: { conditionOption: true, reason: true } }, photos: true },
  });
  if (!returnRequest) throw new Response("Not found", { status: 404 });

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

  return { returnRequest };
};

export default function SummaryStep() {
  const { returnRequest } = useLoaderData<typeof loader>();

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Here's what you've selected</h1>
        <p style={styles.subheading}>
          Exchange options, shipping method, and final submission are coming in the next update —
          for now this confirms your item, condition, and reason were saved correctly.
        </p>

        <ul style={styles.itemList}>
          {returnRequest.lineItems.map((item) => (
            <li key={item.id} style={{ ...styles.item, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <strong>
                {item.title}
                {item.variantTitle ? ` — ${item.variantTitle}` : ""} × {item.quantity}
              </strong>
              <span style={{ color: "#6b6b6b", fontSize: 13 }}>
                Condition: {item.conditionOption?.label ?? "—"}
              </span>
              <span style={{ color: "#6b6b6b", fontSize: 13 }}>Reason: {item.reason?.label ?? "—"}</span>
            </li>
          ))}
        </ul>

        <p style={{ color: "#6b6b6b", fontSize: 13, marginTop: 16 }}>
          ✓ {returnRequest.photos.length} photo{returnRequest.photos.length === 1 ? "" : "s"} received
        </p>
      </div>
    </div>
  );
}
