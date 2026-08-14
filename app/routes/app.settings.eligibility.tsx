import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, TextField, Button, Link } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.shopSettings.findUnique({ where: { shopDomain: session.shop } });
  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

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
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [maxReturnsPerOrder, setMaxReturnsPerOrder] = useState(settings?.maxReturnsPerOrder?.toString() ?? "");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const save = () => {
    fetcher.submit({ maxReturnsPerOrder }, { method: "post" });
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
                This app always follows Shopify's own final sale / return rules -- whatever products or
                collections you exclude there are automatically excluded from the return and exchange
                wizard here too. There's no separate list to maintain in this app.
              </Text>
              <Text as="p">
                <Link url="shopify:admin/settings/legal" target="_blank">
                  Manage final sale products & collections in Settings → Policies
                </Link>
              </Text>
            </BlockStack>
          </Card>
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
