import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  TextField,
  Thumbnail,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { searchCatalogProducts, getCatalogProductsByIds } from "../lib/shopify-catalog.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";

  const [picks, searchResults] = await Promise.all([
    db.exchangeUpsellProduct.findMany({
      where: { shopDomain: session.shop, isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    query ? searchCatalogProducts(admin, query) : Promise.resolve([]),
  ]);

  const pickedProducts = await getCatalogProductsByIds(
    admin,
    picks.map((p) => p.shopifyProductId),
  );

  const picksWithData = picks.map((pick) => ({
    ...pick,
    product: pickedProducts.find((p) => p.id === pick.shopifyProductId) ?? null,
  }));

  return { picksWithData, searchResults, query };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "remove") {
    const id = String(formData.get("id"));
    await db.exchangeUpsellProduct.deleteMany({ where: { id, shopDomain: session.shop } });
    return { ok: true };
  }

  if (intent === "add") {
    const shopifyProductId = String(formData.get("shopifyProductId"));
    const existing = await db.exchangeUpsellProduct.findFirst({
      where: { shopDomain: session.shop, shopifyProductId },
    });
    if (!existing) {
      const count = await db.exchangeUpsellProduct.count({ where: { shopDomain: session.shop } });
      await db.exchangeUpsellProduct.create({
        data: { shopDomain: session.shop, shopifyProductId, sortOrder: count },
      });
    }
    return { ok: true };
  }

  return { ok: false };
};

export default function ExchangeProductsSettings() {
  const { picksWithData, searchResults, query } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSearching = navigation.state === "loading";
  const pickedIds = new Set(picksWithData.map((p) => p.shopifyProductId));
  const [searchValue, setSearchValue] = useState(query);

  return (
    <Page>
      <TitleBar title="Exchange upsell products" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Suggested products
              </Text>
              <Text as="p" tone="subdued">
                Shown to customers on the exchange step to encourage swapping their return for
                something else instead of a refund.
              </Text>

              {picksWithData.length === 0 && (
                <Text as="p" tone="subdued">
                  No upsell products configured yet.
                </Text>
              )}

              {picksWithData.map((pick) => (
                <InlineStack key={pick.id} align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Thumbnail
                      source={pick.product?.imageUrl || "https://cdn.shopify.com/s/assets/admin/no-image-1c98dd91f9e7f45de9c6a67cad74e39c.gif"}
                      alt={pick.product?.title ?? "Product"}
                      size="small"
                    />
                    <Text as="span">{pick.product?.title ?? "(product no longer found)"}</Text>
                  </InlineStack>
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="id" value={pick.id} />
                    <Button variant="plain" tone="critical" submit>
                      Remove
                    </Button>
                  </Form>
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
                  <TextField
                    label="Search products by title"
                    labelHidden
                    name="q"
                    value={searchValue}
                    onChange={setSearchValue}
                    autoComplete="off"
                    placeholder="Search products…"
                    connectedRight={
                      <Button submit loading={isSearching}>
                        Search
                      </Button>
                    }
                  />
                </Form>

                {searchResults.map((product) => (
                  <InlineStack key={product.id} align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail
                        source={product.imageUrl || "https://cdn.shopify.com/s/assets/admin/no-image-1c98dd91f9e7f45de9c6a67cad74e39c.gif"}
                        alt={product.title}
                        size="small"
                      />
                      <Text as="span">{product.title}</Text>
                    </InlineStack>
                    {pickedIds.has(product.id) ? (
                      <Text as="span" tone="subdued">
                        Added
                      </Text>
                    ) : (
                      <Form method="post">
                        <input type="hidden" name="intent" value="add" />
                        <input type="hidden" name="shopifyProductId" value={product.id} />
                        <Button submit>Add</Button>
                      </Form>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
