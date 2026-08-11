import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, TextField, Select, Button, Checkbox } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [restockingFee, labelFee] = await Promise.all([
    db.restockingFeeConfig.findUnique({ where: { shopDomain: session.shop } }),
    db.returnLabelFeeConfig.findUnique({ where: { shopDomain: session.shop } }),
  ]);
  return { restockingFee, labelFee };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "restocking") {
    const feeType = formData.get("feeType") === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENTAGE";
    const value = Number(formData.get("value") ?? 0);
    const isActive = formData.get("isActive") === "true";
    await db.restockingFeeConfig.upsert({
      where: { shopDomain: session.shop },
      update: { feeType, value, isActive },
      create: { shopDomain: session.shop, feeType, value, isActive },
    });
    return { ok: true };
  }

  if (intent === "label") {
    const amountPerItem = Number(formData.get("amountPerItem") ?? 0);
    const isActive = formData.get("isActive") === "true";
    await db.returnLabelFeeConfig.upsert({
      where: { shopDomain: session.shop },
      update: { amountPerItem, isActive },
      create: { shopDomain: session.shop, amountPerItem, isActive },
    });
    return { ok: true };
  }

  return { ok: false };
};

export default function FeesSettings() {
  const { restockingFee, labelFee } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [feeType, setFeeType] = useState(restockingFee?.feeType ?? "PERCENTAGE");
  const [restockingValue, setRestockingValue] = useState(restockingFee?.value?.toString() ?? "10");
  const [restockingActive, setRestockingActive] = useState(restockingFee?.isActive ?? true);

  const [labelAmount, setLabelAmount] = useState(labelFee?.amountPerItem?.toString() ?? "5.99");
  const [labelActive, setLabelActive] = useState(labelFee?.isActive ?? true);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const saveRestocking = () => {
    fetcher.submit(
      { intent: "restocking", feeType, value: restockingValue, isActive: String(restockingActive) },
      { method: "post" },
    );
  };

  const saveLabel = () => {
    fetcher.submit(
      { intent: "label", amountPerItem: labelAmount, isActive: String(labelActive) },
      { method: "post" },
    );
  };

  return (
    <Page>
      <TitleBar title="Shipping & fees" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Restocking fee
              </Text>
              <Text as="p" tone="subdued">
                Applied when the customer ships the return back using their own carrier.
              </Text>
              <Select
                label="Fee type"
                options={[
                  { label: "Percentage of refund", value: "PERCENTAGE" },
                  { label: "Fixed amount", value: "FIXED_AMOUNT" },
                ]}
                value={feeType}
                onChange={(v) => setFeeType(v as "PERCENTAGE" | "FIXED_AMOUNT")}
              />
              <TextField
                label={feeType === "PERCENTAGE" ? "Percentage (%)" : "Amount"}
                type="number"
                value={restockingValue}
                onChange={setRestockingValue}
                autoComplete="off"
              />
              <Checkbox label="Active" checked={restockingActive} onChange={setRestockingActive} />
              <Button variant="primary" onClick={saveRestocking} loading={fetcher.state === "submitting"}>
                Save restocking fee
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Return label fee
              </Text>
              <Text as="p" tone="subdued">
                Charged per returned item when the customer requests a prepaid return label.
              </Text>
              <TextField
                label="Amount per item"
                type="number"
                prefix="$"
                value={labelAmount}
                onChange={setLabelAmount}
                autoComplete="off"
              />
              <Checkbox label="Active" checked={labelActive} onChange={setLabelActive} />
              <Button variant="primary" onClick={saveLabel} loading={fetcher.state === "submitting"}>
                Save label fee
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
