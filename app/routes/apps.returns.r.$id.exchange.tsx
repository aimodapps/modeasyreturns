import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
import {
  searchCatalogProducts,
  getCatalogProductsByIds,
  getVariantById,
} from "../lib/shopify-catalog.server";
import { calculatePriceDifference } from "../lib/exchange.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";
import { getPortalBranding } from "../lib/portal-branding.server";
import { PortalLogo } from "../components/PortalLogo";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) throw new Response("Not found", { status: 404 });
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

  const url = new URL(request.url);
  const searchItemId = url.searchParams.get("forItem");
  const searchTerm = url.searchParams.get("q") ?? "";

  const [upsellPicks, exchangeSelections, searchResults, branding] = await Promise.all([
    db.exchangeUpsellProduct.findMany({
      where: { shopDomain: session.shop, isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    db.exchangeSelection.findMany({
      where: { returnRequestLineItemId: { in: returnRequest.lineItems.map((li) => li.id) } },
    }),
    searchItemId && searchTerm ? searchCatalogProducts(admin, searchTerm) : Promise.resolve([]),
    getPortalBranding(session.shop),
  ]);

  const upsellProducts = await getCatalogProductsByIds(
    admin,
    upsellPicks.map((p) => p.shopifyProductId),
  );

  return { returnRequest, upsellProducts, exchangeSelections, searchItemId, searchTerm, searchResults, branding };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "removeExchange") {
    const lineItemId = String(formData.get("lineItemId"));
    await db.exchangeSelection.deleteMany({ where: { returnRequestLineItemId: lineItemId } });
    return redirect(`/apps/returns/r/${returnRequest.id}/exchange`);
  }

  if (intent === "selectExchange") {
    const lineItemId = String(formData.get("lineItemId"));
    const variantId = String(formData.get("variantId"));

    const lineItem = returnRequest.lineItems.find((li) => li.id === lineItemId);
    if (!lineItem) {
      return { error: "That item isn't part of this return." };
    }

    // Never trust a client-submitted price -- always re-fetch it live.
    const variant = await getVariantById(admin, variantId);
    if (!variant || !variant.availableForSale) {
      return { error: "That product is no longer available. Please choose another." };
    }

    const { direction, amount } = calculatePriceDifference(
      lineItem.unitPrice.toString(),
      variant.price,
      lineItem.quantity,
    );

    await db.exchangeSelection.upsert({
      where: { returnRequestLineItemId: lineItemId },
      update: {
        targetProductId: variant.productId,
        targetVariantId: variant.id,
        targetTitle: variant.productTitle,
        targetVariantTitle: variant.title === "Default Title" ? null : variant.title,
        targetImageUrl: variant.productImageUrl,
        targetUnitPrice: variant.price,
        currencyCode: lineItem.currencyCode,
        priceDifference: amount,
        direction,
      },
      create: {
        returnRequestLineItemId: lineItemId,
        targetProductId: variant.productId,
        targetVariantId: variant.id,
        targetTitle: variant.productTitle,
        targetVariantTitle: variant.title === "Default Title" ? null : variant.title,
        targetImageUrl: variant.productImageUrl,
        targetUnitPrice: variant.price,
        currencyCode: lineItem.currencyCode,
        priceDifference: amount,
        direction,
      },
    });

    return redirect(`/apps/returns/r/${returnRequest.id}/exchange`);
  }

  return redirect(`/apps/returns/r/${returnRequest.id}/shipping`);
};

export default function ExchangeStep() {
  const { returnRequest, upsellProducts, exchangeSelections, searchItemId, searchTerm, searchResults, branding } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const baseAction = `/apps/returns/r/${returnRequest.id}/exchange`;

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <PortalLogo logoUrl={branding.logoUrl} logoWidthPx={branding.logoWidthPx} />
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Want to exchange instead of a refund?</h1>
        <p style={styles.subheading}>
          Pick a replacement for any item below, or just continue for a refund. We'll handle any
          price difference.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {returnRequest.lineItems.map((lineItem) => {
            const selection = exchangeSelections.find((s) => s.returnRequestLineItemId === lineItem.id);
            const isSearchingThisItem = searchItemId === lineItem.id;

            return (
              <div key={lineItem.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
                <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>
                  {lineItem.title}
                  {lineItem.variantTitle ? ` — ${lineItem.variantTitle}` : ""} × {lineItem.quantity}
                </p>
                <p style={{ fontSize: 13, color: "#888", margin: "0 0 12px" }}>
                  Returning for: {lineItem.unitPrice.toString()} {lineItem.currencyCode}
                </p>

                {selection ? (
                  <div style={{ ...styles.productCard, background: "#fafafa" }}>
                    {selection.targetImageUrl ? (
                      <img src={selection.targetImageUrl} alt="" style={styles.productThumb} />
                    ) : (
                      <div style={styles.productThumbPlaceholder} />
                    )}
                    <div style={styles.productInfo}>
                      <span style={styles.productTitle}>
                        Exchanging for: {selection.targetTitle}
                        {selection.targetVariantTitle ? ` — ${selection.targetVariantTitle}` : ""}
                      </span>
                      <span style={styles.productMeta}>
                        {selection.direction === "NONE" && "No price difference"}
                        {selection.direction === "CHARGE" &&
                          `You'll be charged ${selection.priceDifference.toString()} ${selection.currencyCode} more`}
                        {selection.direction === "REFUND" &&
                          `You'll be refunded an extra ${selection.priceDifference.toString()} ${selection.currencyCode}`}
                      </span>
                    </div>
                    <Form method="post" action={baseAction}>
                      <input type="hidden" name="intent" value="removeExchange" />
                      <input type="hidden" name="lineItemId" value={lineItem.id} />
                      <button type="submit" style={{ ...styles.secondaryButton, marginTop: 0 }}>
                        Remove
                      </button>
                    </Form>
                  </div>
                ) : (
                  <>
                    {upsellProducts.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                        {upsellProducts.map((product) => (
                          <Form method="post" action={baseAction} key={product.id} style={styles.productCard}>
                            <input type="hidden" name="intent" value="selectExchange" />
                            <input type="hidden" name="lineItemId" value={lineItem.id} />
                            {product.imageUrl ? (
                              <img src={product.imageUrl} alt="" style={styles.productThumb} />
                            ) : (
                              <div style={styles.productThumbPlaceholder} />
                            )}
                            <div style={styles.productInfo}>
                              <span style={styles.productTitle}>{product.title}</span>
                            </div>
                            {product.variants.length > 1 ? (
                              <select name="variantId" style={styles.qtyInput}>
                                {product.variants.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.title} — {v.price}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input type="hidden" name="variantId" value={product.variants[0]?.id} />
                            )}
                            <button type="submit" style={{ ...styles.secondaryButton, marginTop: 0 }}>
                              Exchange
                            </button>
                          </Form>
                        ))}
                      </div>
                    )}

                    <Form method="get" action={baseAction} style={{ display: "flex", gap: 8 }}>
                      <input type="hidden" name="forItem" value={lineItem.id} />
                      <input
                        style={{ ...styles.input, flex: 1 }}
                        type="text"
                        name="q"
                        placeholder="Search the catalog for something else…"
                        defaultValue={isSearchingThisItem ? searchTerm : ""}
                      />
                      <button type="submit" style={{ ...styles.secondaryButton, marginTop: 0 }}>
                        Search
                      </button>
                    </Form>

                    {isSearchingThisItem && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                        {searchResults.length === 0 && (
                          <p style={{ fontSize: 13, color: "#888" }}>No products found.</p>
                        )}
                        {searchResults.map((product) => (
                          <Form method="post" action={baseAction} key={product.id} style={styles.productCard}>
                            <input type="hidden" name="intent" value="selectExchange" />
                            <input type="hidden" name="lineItemId" value={lineItem.id} />
                            {product.imageUrl ? (
                              <img src={product.imageUrl} alt="" style={styles.productThumb} />
                            ) : (
                              <div style={styles.productThumbPlaceholder} />
                            )}
                            <div style={styles.productInfo}>
                              <span style={styles.productTitle}>{product.title}</span>
                            </div>
                            {product.variants.length > 1 ? (
                              <select name="variantId" style={styles.qtyInput}>
                                {product.variants.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.title} — {v.price}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input type="hidden" name="variantId" value={product.variants[0]?.id} />
                            )}
                            <button type="submit" style={{ ...styles.secondaryButton, marginTop: 0 }}>
                              Exchange
                            </button>
                          </Form>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        <Form method="post" action={baseAction} style={{ marginTop: 20 }}>
          <input type="hidden" name="intent" value="continue" />
          <button style={styles.button} type="submit" disabled={isSubmitting}>
            Continue
          </button>
        </Form>
      </div>
    </div>
  );
}
