import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, TextField, Button } from "@shopify/polaris";
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

  const supportEmail = String(formData.get("supportEmail") ?? "").trim() || null;
  const returnPolicyUrl = String(formData.get("returnPolicyUrl") ?? "").trim() || null;
  const returnWindowDays = Number(formData.get("returnWindowDays") ?? 30);
  const orderNumberPlaceholder = String(formData.get("orderNumberPlaceholder") ?? "").trim() || null;

  await db.shopSettings.upsert({
    where: { shopDomain: session.shop },
    update: { supportEmail, returnPolicyUrl, returnWindowDays, orderNumberPlaceholder },
    create: { shopDomain: session.shop, supportEmail, returnPolicyUrl, returnWindowDays, orderNumberPlaceholder },
  });

  return { ok: true };
};

export default function GeneralSettings() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [supportEmail, setSupportEmail] = useState(settings?.supportEmail ?? "");
  const [returnPolicyUrl, setReturnPolicyUrl] = useState(settings?.returnPolicyUrl ?? "");
  const [returnWindowDays, setReturnWindowDays] = useState(settings?.returnWindowDays?.toString() ?? "30");
  const [orderNumberPlaceholder, setOrderNumberPlaceholder] = useState(settings?.orderNumberPlaceholder ?? "");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const save = () => {
    fetcher.submit({ supportEmail, returnPolicyUrl, returnWindowDays, orderNumberPlaceholder }, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="General settings" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Notifications & return window
              </Text>
              <TextField
                label="Admin notification email"
                helpText="Where 'Return Request Initiated' emails are sent. Required for admin email notifications to go out at all."
                type="email"
                value={supportEmail}
                onChange={setSupportEmail}
                autoComplete="off"
              />
              <TextField
                label="Return policy URL"
                helpText="Linked from denial messages when a condition denies a return."
                value={returnPolicyUrl}
                onChange={setReturnPolicyUrl}
                autoComplete="off"
              />
              <TextField
                label="Return window (days)"
                type="number"
                value={returnWindowDays}
                onChange={setReturnWindowDays}
                autoComplete="off"
              />
              <TextField
                label="Order number field placeholder"
                helpText='Shown as greyed-out example text in the storefront order-number field, e.g. "#MOD0001". Purely cosmetic -- customers still type their own order number.'
                value={orderNumberPlaceholder}
                onChange={setOrderNumberPlaceholder}
                placeholder="#1001"
                autoComplete="off"
              />
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
