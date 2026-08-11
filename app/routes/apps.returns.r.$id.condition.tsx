import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
import { portalStyles as styles } from "../lib/portal-styles";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);
  if (returnRequest.lineItems.length === 0) {
    throw redirect(`/apps/returns/r/${returnRequest.id}/items`);
  }

  const conditions = await db.conditionOption.findMany({
    where: { shopDomain: session.shop, isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  return { returnRequest, conditions };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const conditionId = String(formData.get("conditionId") ?? "");

  const condition = await db.conditionOption.findFirst({
    where: { id: conditionId, shopDomain: session.shop },
  });

  if (!condition) {
    return { error: "Please choose an item condition.", denied: false as const, condition: null };
  }

  const denied = condition.action === "DENY";

  await db.returnRequestLineItem.updateMany({
    where: { returnRequestId: returnRequest.id },
    data: { conditionOptionId: condition.id, conditionDenied: denied },
  });

  if (denied) {
    return { denied: true as const, condition, error: null };
  }

  return redirect(`/apps/returns/r/${returnRequest.id}/photo`);
};

export default function ConditionStep() {
  const { returnRequest, conditions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (actionData?.denied) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
          <h1 style={styles.heading}>We're unable to accept this return</h1>
          <p style={{ fontSize: 15, color: "#333", lineHeight: 1.6 }}>
            {actionData.condition.denyMessage}
          </p>
          {actionData.condition.denyLinkUrl && (
            <p>
              <a href={actionData.condition.denyLinkUrl} target="_blank" rel="noreferrer">
                Learn more
              </a>
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>What condition is the item in?</h1>
        <p style={styles.subheading}>
          This applies to all the items you're returning in this request.
        </p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/condition`} style={styles.form}>
          {conditions.map((condition) => (
            <label key={condition.id} style={styles.optionCard}>
              <span style={styles.optionLabel}>
                <input type="radio" name="conditionId" value={condition.id} required />
                {condition.label}
              </span>
            </label>
          ))}

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Continue"}
          </button>
        </Form>

        {actionData?.error && <p style={styles.error}>{actionData.error}</p>}
      </div>
    </div>
  );
}
