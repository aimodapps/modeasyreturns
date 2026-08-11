import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  IndexTable,
  Badge,
  Modal,
  TextField,
  Select,
  Checkbox,
  Box,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rules = await db.discountRule.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "asc" },
  });
  return { rules };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "delete") {
    const id = String(formData.get("id"));
    await db.discountRule.deleteMany({ where: { id, shopDomain: session.shop } });
    return { ok: true };
  }

  const id = formData.get("id") ? String(formData.get("id")) : null;
  const discountTitleMatch = String(formData.get("discountTitleMatch") ?? "").trim();
  const discountCode = String(formData.get("discountCode") ?? "").trim() || null;
  const minQuantityRaw = String(formData.get("minQuantity") ?? "").trim();
  const minAmountRaw = String(formData.get("minAmount") ?? "").trim();
  const appliesTo: "SPECIFIC_PRODUCTS" | "ALL_ITEMS" =
    formData.get("appliesTo") === "SPECIFIC_PRODUCTS" ? "SPECIFIC_PRODUCTS" : "ALL_ITEMS";
  const scopeProductIdsRaw = String(formData.get("scopeProductIds") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const isActive = formData.get("isActive") === "true";

  if (!discountTitleMatch) {
    return { ok: false, error: "The discount title to match is required." };
  }
  if (!minQuantityRaw && !minAmountRaw) {
    return { ok: false, error: "Set a minimum quantity, a minimum amount, or both." };
  }

  const data = {
    discountTitleMatch,
    discountCode,
    type: "ORDER_PERCENTAGE" as const,
    minQuantity: minQuantityRaw ? Number(minQuantityRaw) : null,
    minAmount: minAmountRaw ? Number(minAmountRaw) : null,
    discountValue: 0,
    appliesTo,
    scopeProductIds:
      appliesTo === "SPECIFIC_PRODUCTS" && scopeProductIdsRaw
        ? scopeProductIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    notes,
    isActive,
  };

  if (id) {
    await db.discountRule.update({ where: { id }, data });
  } else {
    await db.discountRule.create({ data: { ...data, shopDomain: session.shop } });
  }

  return { ok: true };
};

type RuleRow = Awaited<ReturnType<typeof useLoaderData<typeof loader>>>["rules"][number];

const EMPTY_FORM = {
  id: "",
  discountTitleMatch: "",
  discountCode: "",
  minQuantity: "",
  minAmount: "",
  appliesTo: "ALL_ITEMS",
  scopeProductIds: "",
  notes: "",
  isActive: true,
};

export default function DiscountRulesSettings() {
  const { rules } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setModalOpen(false);
      shopify.toast.show("Saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (rule: RuleRow) => {
    setForm({
      id: rule.id,
      discountTitleMatch: rule.discountTitleMatch,
      discountCode: rule.discountCode ?? "",
      minQuantity: rule.minQuantity?.toString() ?? "",
      minAmount: rule.minAmount?.toString() ?? "",
      appliesTo: rule.appliesTo,
      scopeProductIds: Array.isArray(rule.scopeProductIds) ? rule.scopeProductIds.join(", ") : "",
      notes: rule.notes ?? "",
      isActive: rule.isActive,
    });
    setModalOpen(true);
  };

  const submit = () => {
    fetcher.submit(
      {
        intent: "save",
        id: form.id,
        discountTitleMatch: form.discountTitleMatch,
        discountCode: form.discountCode,
        minQuantity: form.minQuantity,
        minAmount: form.minAmount,
        appliesTo: form.appliesTo,
        scopeProductIds: form.scopeProductIds,
        notes: form.notes,
        isActive: String(form.isActive),
      },
      { method: "post" },
    );
  };

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete", id }, { method: "post" });
  };

  const rowMarkup = rules.map((rule, index) => (
    <IndexTable.Row id={rule.id} key={rule.id} position={index} onClick={() => openEdit(rule)}>
      <IndexTable.Cell>
        <Text as="span" fontWeight="medium">
          {rule.discountTitleMatch}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {rule.minQuantity ? `Min qty ${rule.minQuantity}` : rule.minAmount ? `Min amount ${rule.minAmount}` : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={rule.isActive ? "success" : undefined}>{rule.isActive ? "Active" : "Inactive"}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span onClick={(e) => e.stopPropagation()}>
          <Button variant="plain" tone="critical" onClick={() => remove(rule.id)}>
            Delete
          </Button>
        </span>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Discount reallocation rules">
        <button variant="primary" onClick={openNew}>
          Add rule
        </button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="p" tone="subdued">
              Mirror a multi-item discount's eligibility rule here (e.g. "Buy 3 Get 20% off" requires
              3+ items) so refunds are recalculated correctly when a customer returns only some of
              the qualifying items. Match by the exact discount title (or code) as it appears on the
              order.
            </Text>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "rule", plural: "rules" }}
              itemCount={rules.length}
              headings={[{ title: "Discount title" }, { title: "Threshold" }, { title: "Status" }, { title: "" }]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
            {rules.length === 0 && (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No discount rules configured yet.
                </Text>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? "Edit discount rule" : "Add discount rule"}
        primaryAction={{ content: "Save", onAction: submit, loading: fetcher.state === "submitting" }}
        secondaryActions={[{ content: "Cancel", onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Discount title (as shown on the order)"
              helpText='e.g. "Buy 3 Get 20% off" -- must match exactly'
              value={form.discountTitleMatch}
              onChange={(discountTitleMatch) => setForm((f) => ({ ...f, discountTitleMatch }))}
              autoComplete="off"
            />
            <TextField
              label="Discount code (optional, alternative match)"
              value={form.discountCode}
              onChange={(discountCode) => setForm((f) => ({ ...f, discountCode }))}
              autoComplete="off"
            />
            <TextField
              label="Minimum quantity to still qualify"
              type="number"
              value={form.minQuantity}
              onChange={(minQuantity) => setForm((f) => ({ ...f, minQuantity }))}
              autoComplete="off"
            />
            <TextField
              label="Minimum order amount to still qualify (optional)"
              type="number"
              value={form.minAmount}
              onChange={(minAmount) => setForm((f) => ({ ...f, minAmount }))}
              autoComplete="off"
            />
            <Select
              label="Applies to"
              options={[
                { label: "All items", value: "ALL_ITEMS" },
                { label: "Specific products (configure later)", value: "SPECIFIC_PRODUCTS" },
              ]}
              value={form.appliesTo}
              onChange={(appliesTo) => setForm((f) => ({ ...f, appliesTo }))}
            />
            {form.appliesTo === "SPECIFIC_PRODUCTS" && (
              <TextField
                label="Scope to product IDs (comma-separated Shopify product GIDs)"
                helpText="e.g. gid://shopify/Product/123, gid://shopify/Product/456"
                value={form.scopeProductIds}
                onChange={(scopeProductIds) => setForm((f) => ({ ...f, scopeProductIds }))}
                autoComplete="off"
              />
            )}
            <TextField
              label="Notes (internal)"
              value={form.notes}
              onChange={(notes) => setForm((f) => ({ ...f, notes }))}
              multiline={2}
              autoComplete="off"
            />
            <Checkbox
              label="Active"
              checked={form.isActive}
              onChange={(isActive) => setForm((f) => ({ ...f, isActive }))}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
