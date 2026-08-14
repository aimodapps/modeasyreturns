import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  unstable_composeUploadHandlers,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, TextField, Button, Thumbnail } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { uploadShopLogo, resolveFileUrlWithRetry, PhotoUploadError } from "../lib/photo-upload.server";

const MAX_LOGO_BYTES = 4 * 1024 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.shopSettings.findUnique({ where: { shopDomain: session.shop } });
  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_composeUploadHandlers(
      unstable_createMemoryUploadHandler({ maxPartSize: MAX_LOGO_BYTES }),
    );
    let formData;
    try {
      formData = await unstable_parseMultipartFormData(request, uploadHandler);
    } catch {
      return { ok: false as const, error: "That image is too large. Please upload a file under 4MB." };
    }

    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false as const, error: "Please choose an image to upload." };
    }
    if (!file.type.startsWith("image/")) {
      return { ok: false as const, error: "Please upload an image file (JPG, PNG, or SVG)." };
    }

    try {
      const { shopifyFileId } = await uploadShopLogo(admin, { file, filename: file.name || "logo.png" });
      const logoUrl = await resolveFileUrlWithRetry(admin, shopifyFileId);
      if (!logoUrl) {
        return {
          ok: false as const,
          error: "The logo uploaded but is still processing on Shopify's side -- try saving again in a moment.",
        };
      }
      await db.shopSettings.upsert({
        where: { shopDomain: session.shop },
        update: { logoUrl },
        create: { shopDomain: session.shop, logoUrl },
      });
    } catch (error) {
      if (error instanceof PhotoUploadError) {
        return { ok: false as const, error: error.message };
      }
      console.error("[app.settings.branding] unhandled logo upload error", error);
      return { ok: false as const, error: "We couldn't upload that logo. Please try again." };
    }

    return { ok: true as const };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "removeLogo") {
    await db.shopSettings.upsert({
      where: { shopDomain: session.shop },
      update: { logoUrl: null },
      create: { shopDomain: session.shop, logoUrl: null },
    });
    return { ok: true as const };
  }

  const logoWidthPxRaw = String(formData.get("logoWidthPx") ?? "").trim();
  const logoWidthPx = logoWidthPxRaw ? Number(logoWidthPxRaw) : null;
  if (logoWidthPx != null && (!Number.isInteger(logoWidthPx) || logoWidthPx < 20 || logoWidthPx > 600)) {
    return { ok: false as const, error: "Logo width must be a whole number between 20 and 600 pixels." };
  }

  const pageTitle = String(formData.get("pageTitle") ?? "").trim() || null;
  const introDescription = String(formData.get("introDescription") ?? "").trim() || null;

  await db.shopSettings.upsert({
    where: { shopDomain: session.shop },
    update: { logoWidthPx, pageTitle, introDescription },
    create: { shopDomain: session.shop, logoWidthPx, pageTitle, introDescription },
  });

  return { ok: true as const };
};

export default function BrandingSettings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const textFetcher = useFetcher<typeof action>();
  const removeFetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isUploading = navigation.state === "submitting";

  const [logoWidthPx, setLogoWidthPx] = useState(settings?.logoWidthPx?.toString() ?? "140");
  const [pageTitle, setPageTitle] = useState(settings?.pageTitle ?? "");
  const [introDescription, setIntroDescription] = useState(settings?.introDescription ?? "");

  useEffect(() => {
    if (actionData?.ok) shopify.toast.show("Saved");
  }, [actionData, shopify]);
  useEffect(() => {
    if (textFetcher.state === "idle" && textFetcher.data?.ok) shopify.toast.show("Saved");
  }, [textFetcher.state, textFetcher.data, shopify]);
  useEffect(() => {
    if (removeFetcher.state === "idle" && removeFetcher.data?.ok) shopify.toast.show("Logo removed");
  }, [removeFetcher.state, removeFetcher.data, shopify]);

  const saveText = () => {
    textFetcher.submit({ logoWidthPx, pageTitle, introDescription }, { method: "post" });
  };

  const removeLogo = () => {
    removeFetcher.submit({ intent: "removeLogo" }, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Branding" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Logo
              </Text>
              <Text as="p" tone="subdued">
                Shown at the top of every page in the customer-facing return & exchange wizard.
              </Text>

              {settings?.logoUrl && (
                <InlineStack gap="300" blockAlign="center">
                  <Thumbnail source={settings.logoUrl} alt="Current logo" size="large" />
                  <Button variant="plain" tone="critical" onClick={removeLogo} loading={removeFetcher.state === "submitting"}>
                    Remove logo
                  </Button>
                </InlineStack>
              )}

              <Form method="post" encType="multipart/form-data">
                <BlockStack gap="300">
                  <input type="file" name="logo" accept="image/*" />
                  {actionData && !actionData.ok && (
                    <Text as="p" tone="critical">
                      {actionData.error}
                    </Text>
                  )}
                  <InlineStack>
                    <Button submit loading={isUploading}>
                      {settings?.logoUrl ? "Replace logo" : "Upload logo"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>

              <TextField
                label="Logo width (px)"
                helpText="How wide the logo displays in the wizard, between 20 and 600px."
                type="number"
                min={20}
                max={600}
                value={logoWidthPx}
                onChange={setLogoWidthPx}
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Intro page copy
              </Text>
              <Text as="p" tone="subdued">
                Shown on the first page of the wizard, where customers enter their order number.
              </Text>
              <TextField
                label="Page title"
                placeholder="Start a return or exchange"
                value={pageTitle}
                onChange={setPageTitle}
                autoComplete="off"
              />
              <TextField
                label="Intro description"
                placeholder="Enter your order number and the email or phone number used at checkout."
                value={introDescription}
                onChange={setIntroDescription}
                multiline={2}
                autoComplete="off"
              />
              {textFetcher.data && !textFetcher.data.ok && (
                <Text as="p" tone="critical">
                  {textFetcher.data.error}
                </Text>
              )}
              <InlineStack>
                <Button variant="primary" onClick={saveText} loading={textFetcher.state === "submitting"}>
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
