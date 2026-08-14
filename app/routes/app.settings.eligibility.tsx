import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Badge,
  Thumbnail,
  Box,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { searchCatalogProducts } from "../lib/shopify-catalog.server";
import { searchCatalogCollections } from "../lib/return-exclusions.server";

const NO_IMAGE = "https://cdn.shopify.com/s/assets/admin/no-image-1c98dd91f9e7f45de9c6a67cad74e39c.gif";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productQuery = url.searchParams.get("productQuery") ?? "";
  const collectionQuery = url.searchParams.get("collectionQuery") ?? "";

  const [settings, exclusions, productResults, collectionResults] = await Promise.all([
    db.shopSettings.findUnique({ where: { shopDomain: session.shop } }),
    db.returnExclusion.findMany({ where: { shopDomain: session.shop }, orderBy: { createdAt: "desc" } }),
    productQuery ? searchCatalogProducts(admin, productQuery) : Promise.resolve([]),
    collectionQuery ? searchCatalogCollections(admin, collectionQuery) : Promise.resolve([]),
  ]);

  return { settings, exclusions, productResults, collectionResults, productQuery, collectionQuery };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "addExclusion") {
    const type = String(formData.get("type")) === "COLLECTION" ? "COLLECTION" : "PRODUCT";
    const shopifyResourceId = String(formData.get("shopifyResourceId"));
    const title = String(formData.get("title"));
    await db.returnExclusion.upsert({
      where: { shopDomain_shopifyResourceId: { shopDomain: session.shop, shopifyResourceId } },
      update: { title, type },
      create: { shopDomain: session.shop, type, shopifyResourceId, title },
    });
    return { ok: true as const };
  }

  if (intent === "removeExclusion") {
    const id = String(formData.get("id"));
    await db.returnExclusion.deleteMany({ where: { id, shopDomain: session.shop } });
    return { ok: true as const };
  }

  const maxReturnsPerOrderRaw = String(formData.get("maxReturnsPerOrder") ?? "").trim();
  const maxReturnsPerOrder = maxReturnsPerOrderRaw ? Number(maxReturnsPerOrderRaw) : null;

  if (maxReturnsPerOrder != null && (!Number.isInteger(maxReturnsPerOrder) || maxReturnsPerOrder < 1)) {
    return { ok: false as const, error: "Enter a whole number of 1 or more, or leave it blank for unlimited." };
  }

  await db.shopSettings.upsert({
    where: { shopDomain: session.shop },
    update: { maxReturnsPerOrder },
    create: { shopDomain: session.shop, maxReturnsPerOrder },
  });

  return { ok: true as const };
};

export default function EligibilitySettings() {
  const { settings, exclusions, productResults, collectionResults, productQuery, collectionQuery } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const listFetcher = useFetcher();
  const shopify = useAppBridge();

  const [maxReturnsPerOrder, setMaxReturnsPerOrder] = useState(settings?.maxReturnsPerOrder?.toString() ?? "");
  const [productSearch, setProductSearch] = useState(productQuery);
  const [collectionSearch, setCollectionSearch] = useState(collectionQuery);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const save = () => {
    fetcher.submit({ maxReturnsPerOrder }, { method: "post" });
  };

  const excludedResourceIds = new Set(exclusions.map((e) => e.shopifyResourceId));

  const addExclusion = (type: "PRODUCT" | "COLLECTION", shopifyResourceId: string, title: string) => {
    listFetcher.submit({ intent: "addExclusion", type, shopifyResourceId, title }, { method: "post" });
  };

  const removeExclusion = (id: string) => {
    listFetcher.submit({ intent: "removeExclusion", id }, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Eligibility" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Non-returnable products & collections
              </Text>
              <Text as="p" tone="subdued">
                Shopify's own "final sale" return rules (Settings → Policies) aren't readable through
                the API this app uses, so they can't be relied on here -- anything you mark final sale
                there will still show as returnable in this wizard unless it's also added below. Items
                added here show in the wizard as disabled with a "Non-returnable" label, rather than
                being hidden, so a customer who expects to find something there sees why.
              </Text>

              {exclusions.length === 0 && (
                <Text as="p" tone="subdued">
                  No products or collections excluded yet.
                </Text>
              )}
              {exclusions.map((e) => (
                <InlineStack key={e.id} align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Badge>{e.type === "PRODUCT" ? "Product" : "Collection"}</Badge>
                    <Text as="span">{e.title}</Text>
                  </InlineStack>
                  <Button variant="plain" tone="critical" onClick={() => removeExclusion(e.id)}>
                    Remove
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>

          <Box paddingBlockStart="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Add a product
                </Text>
                <Form method="get">
                  <input type="hidden" name="collectionQuery" value={collectionQuery} />
                  <TextField
                    label="Search products by title"
                    labelHidden
                    name="productQuery"
                    value={productSearch}
                    onChange={setProductSearch}
                    autoComplete="off"
                    placeholder="Search products…"
                    connectedRight={<Button submit>Search</Button>}
                  />
                </Form>

                {productResults.map((product) => (
                  <InlineStack key={product.id} align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail source={product.imageUrl || NO_IMAGE} alt={product.title} size="small" />
                      <Text as="span">{product.title}</Text>
                    </InlineStack>
                    {excludedResourceIds.has(product.id) ? (
                      <Text as="span" tone="subdued">
                        Excluded
                      </Text>
                    ) : (
                      <Button onClick={() => addExclusion("PRODUCT", product.id, product.title)}>Exclude</Button>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Box>

          <Box paddingBlockStart="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Add a collection
                </Text>
                <Form method="get">
                  <input type="hidden" name="productQuery" value={productQuery} />
                  <TextField
                    label="Search collections by title"
                    labelHidden
                    name="collectionQuery"
                    value={collectionSearch}
                    onChange={setCollectionSearch}
                    autoComplete="off"
                    placeholder="Search collections…"
                    connectedRight={<Button submit>Search</Button>}
                  />
                </Form>

                {collectionResults.map((collection) => (
                  <InlineStack key={collection.id} align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail source={collection.imageUrl || NO_IMAGE} alt={collection.title} size="small" />
                      <Text as="span">{collection.title}</Text>
                    </InlineStack>
                    {excludedResourceIds.has(collection.id) ? (
                      <Text as="span" tone="subdued">
                        Excluded
                      </Text>
                    ) : (
                      <Button onClick={() => addExclusion("COLLECTION", collection.id, collection.title)}>
                        Exclude
                      </Button>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Box>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Requests per order
              </Text>
              <Text as="p" tone="subdued">
                Limits how many separate return or exchange requests can be submitted against the same
                order. This does not limit how many items can be included in a single request -- a
                customer can still return several items together at once.
              </Text>
              <TextField
                label="Maximum requests per order"
                helpText="Leave blank for unlimited. For example, 1 means a second request can't be started once one has already been submitted for that order."
                type="number"
                min={1}
                value={maxReturnsPerOrder}
                onChange={setMaxReturnsPerOrder}
                autoComplete="off"
              />
              {fetcher.data && !fetcher.data.ok && (
                <Text as="p" tone="critical">
                  {fetcher.data.error}
                </Text>
              )}
              <Button variant="primary" onClick={save} loading={fetcher.state === "submitting"}>
                Save
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
