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
  return { returnRequest };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const selectedIds = formData.getAll("itemId").map(String);

  if (selectedIds.length === 0) {
    return { error: "Please select at least one item to return or exchange." };
  }

  const selections = selectedIds.map((fulfillmentLineItemId) => {
    const snapshotItem = returnRequest.orderSnapshot.items.find(
      (item) => item.fulfillmentLineItemId === fulfillmentLineItemId,
    );
    const requestedQty = Number(formData.get(`qty_${fulfillmentLineItemId}`) ?? 1);
    const maxQty = snapshotItem?.quantity ?? 1;
    const quantity = Math.min(Math.max(1, requestedQty), maxQty);
    return { snapshotItem, quantity, fulfillmentLineItemId };
  });

  await db.$transaction([
    db.returnRequestLineItem.deleteMany({ where: { returnRequestId: returnRequest.id } }),
    ...selections
      .filter((s) => s.snapshotItem)
      .map((s) =>
        db.returnRequestLineItem.create({
          data: {
            returnRequestId: returnRequest.id,
            fulfillmentLineItemId: s.fulfillmentLineItemId,
            shopifyLineItemId: s.snapshotItem!.lineItemId,
            title: s.snapshotItem!.title,
            variantTitle: s.snapshotItem!.variantTitle,
            quantity: s.quantity,
            unitPrice: s.snapshotItem!.unitPrice,
            currencyCode: s.snapshotItem!.currencyCode,
          },
        }),
      ),
  ]);

  return redirect(`/apps/returns/r/${returnRequest.id}/condition`);
};

export default function ItemSelectionStep() {
  const { returnRequest } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const selectedIds = new Set(returnRequest.lineItems.map((li) => li.fulfillmentLineItemId));

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Which items would you like to return?</h1>
        <p style={styles.subheading}>Select one or more items and confirm the quantity.</p>

        <Form method="post" action={`/apps/returns/r/${returnRequest.id}/items`} style={styles.form}>
          <ul style={styles.itemList}>
            {returnRequest.orderSnapshot.items.map((item) => (
              <li key={item.fulfillmentLineItemId} style={styles.item}>
                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    name="itemId"
                    value={item.fulfillmentLineItemId}
                    defaultChecked={selectedIds.has(item.fulfillmentLineItemId)}
                  />
                  <span>
                    {item.title}
                    {item.variantTitle ? ` — ${item.variantTitle}` : ""}
                    <br />
                    <span style={{ color: "#888", fontSize: 13 }}>
                      {item.unitPrice} {item.currencyCode}
                    </span>
                  </span>
                </label>
                {item.quantity > 1 ? (
                  <input
                    type="number"
                    name={`qty_${item.fulfillmentLineItemId}`}
                    min={1}
                    max={item.quantity}
                    defaultValue={
                      returnRequest.lineItems.find(
                        (li) => li.fulfillmentLineItemId === item.fulfillmentLineItemId,
                      )?.quantity ?? item.quantity
                    }
                    style={{ ...styles.input, width: 64 }}
                  />
                ) : (
                  <input type="hidden" name={`qty_${item.fulfillmentLineItemId}`} value={1} />
                )}
              </li>
            ))}
          </ul>

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Continue"}
          </button>
        </Form>

        {actionData?.error && <p style={styles.error}>{actionData.error}</p>}
      </div>
    </div>
  );
}
