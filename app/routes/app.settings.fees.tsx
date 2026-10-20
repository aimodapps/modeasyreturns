import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, TextField, Select, Button, Checkbox } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [restockingFee, labelFee, exchangeShippingFee] = await Promise.all([
    db.restockingFeeConfig.findUnique({ where: { shopDomain: session.shop } }),
    db.returnLabelFeeConfig.findUnique({ where: { shopDomain: session.shop } }),
    db.exchangeShippingFeeConfig.findUnique({ where: { shopDomain: session.shop } }),
  ]);
  return { restockingFee, labelFee, exchangeShippingFee };
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

  if (intent === "exchangeShipping") {
    const feeAmount = Number(formData.get("feeAmount") ?? 0);
    const thresholdRaw = String(formData.get("freeShippingThreshold") ?? "").trim();
    const freeShippingThreshold = thresholdRaw ? Number(thresholdRaw) : null;
    const isActive = formData.get("isActive") === "true";

    if (!Number.isFinite(feeAmount) || feeAmount < 0) {
      return { ok: false, error: "Enter a shipping fee of 0 or more." };
    }
    if (freeShippingThreshold != null && (!Number.isFinite(freeShippingThreshold) || freeShippingThreshold < 0)) {
      return { ok: false, error: "Enter a free-shipping minimum of 0 or more, or leave it blank." };
    }

    await db.exchangeShippingFeeConfig.upsert({
      where: { shopDomain: session.shop },
      update: { feeAmount, freeShippingThreshold, isActive },
      create: { shopDomain: session.shop, feeAmount, freeShippingThreshold, isActive },
    });
    return { ok: true };
  }

  return { ok: false };
};

export default function FeesSettings() {
  const { restockingFee, labelFee, exchangeShippingFee } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [feeType, setFeeType] = useState(restockingFee?.feeType ?? "PERCENTAGE");
  const [restockingValue, setRestockingValue] = useState(restockingFee?.value?.toString() ?? "10");
  const [restockingActive, setRestockingActive] = useState(restockingFee?.isActive ?? true);

  const [labelAmount, setLabelAmount] = useState(labelFee?.amountPerItem?.toString() ?? "5.99");
  const [labelActive, setLabelActive] = useState(labelFee?.isActive ?? true);

  const [exchangeFeeAmount, setExchangeFeeAmount] = useState(exchangeShippingFee?.feeAmount?.toString() ?? "6.95");
  const [exchangeThreshold, setExchangeThreshold] = useState(
    exchangeShippingFee ? (exchangeShippingFee.freeShippingThreshold?.toString() ?? "") : "65",
  );
  const [exchangeActive, setExchangeActive] = useState(exchangeShippingFee?.isActive ?? true);

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

  const saveExchangeShipping = () => {
    fetcher.submit(
      {
        intent: "exchangeShipping",
        feeAmount: exchangeFeeAmount,
        freeShippingThreshold: exchangeThreshold,
        isActive: String(exchangeActive),
      },
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

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Exchange shipping fee
              </Text>
              <Text as="p" tone="subdued">
                Charged for shipping the replacement item(s) of an exchange. Your storefront's free
                shipping minimum doesn't carry over to exchanges, so it's set here. Replacement items
                worth at least the minimum ship free; anything less pays the fee. Added to any return
                shipping fee and collected the same way (taken from a refund, or added to the balance
                the customer owes on an exchange-only request).
              </Text>
              {!exchangeShippingFee && (
                <Text as="p" tone="caution">
                  Not saved yet -- exchanges ship free until you save this.
                </Text>
              )}
              <TextField
                label="Shipping fee"
                type="number"
                prefix="$"
                value={exchangeFeeAmount}
                onChange={setExchangeFeeAmount}
                autoComplete="off"
              />
              <TextField
                label="Free shipping minimum"
                type="number"
                prefix="$"
                value={exchangeThreshold}
                onChange={setExchangeThreshold}
                helpText="Based on the combined price of the replacement items. Leave blank to always charge the fee."
                autoComplete="off"
              />
              <Checkbox label="Active" checked={exchangeActive} onChange={setExchangeActive} />
              {fetcher.data && !fetcher.data.ok && "error" in fetcher.data && fetcher.data.error && (
                <Text as="p" tone="critical">
                  {fetcher.data.error}
                </Text>
              )}
              <Button variant="primary" onClick={saveExchangeShipping} loading={fetcher.state === "submitting"}>
                Save exchange shipping fee
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
