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
  const conditions = await db.conditionOption.findMany({
    where: { shopDomain: session.shop },
    orderBy: { sortOrder: "asc" },
  });
  return { conditions };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "delete") {
    const id = String(formData.get("id"));
    await db.conditionOption.deleteMany({ where: { id, shopDomain: session.shop } });
    return { ok: true };
  }

  const id = formData.get("id") ? String(formData.get("id")) : null;
  const label = String(formData.get("label") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const action = formData.get("action") === "DENY" ? "DENY" : "PROCEED";
  const denyMessage = String(formData.get("denyMessage") ?? "").trim() || null;
  const denyLinkUrl = String(formData.get("denyLinkUrl") ?? "").trim() || null;
  const isActive = formData.get("isActive") === "true";

  if (!label || !code) {
    return { ok: false, error: "Label and code are required." };
  }

  const data = { label, code, action, denyMessage, denyLinkUrl, isActive } as const;

  if (id) {
    await db.conditionOption.update({ where: { id }, data });
  } else {
    const count = await db.conditionOption.count({ where: { shopDomain: session.shop } });
    await db.conditionOption.create({
      data: { ...data, shopDomain: session.shop, sortOrder: count },
    });
  }

  return { ok: true };
};

type ConditionRow = Awaited<ReturnType<typeof useLoaderData<typeof loader>>>["conditions"][number];

const EMPTY_FORM = {
  id: "",
  label: "",
  code: "",
  action: "PROCEED",
  denyMessage: "",
  denyLinkUrl: "",
  isActive: true,
};

export default function ConditionsSettings() {
  const { conditions } = useLoaderData<typeof loader>();
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

  const openEdit = (condition: ConditionRow) => {
    setForm({
      id: condition.id,
      label: condition.label,
      code: condition.code,
      action: condition.action,
      denyMessage: condition.denyMessage ?? "",
      denyLinkUrl: condition.denyLinkUrl ?? "",
      isActive: condition.isActive,
    });
    setModalOpen(true);
  };

  const submit = () => {
    fetcher.submit(
      {
        intent: "save",
        id: form.id,
        label: form.label,
        code: form.code,
        action: form.action,
        denyMessage: form.denyMessage,
        denyLinkUrl: form.denyLinkUrl,
        isActive: String(form.isActive),
      },
      { method: "post" },
    );
  };

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete", id }, { method: "post" });
  };

  const rowMarkup = conditions.map((condition, index) => (
    <IndexTable.Row
      id={condition.id}
      key={condition.id}
      position={index}
      onClick={() => openEdit(condition)}
    >
      <IndexTable.Cell>
        <Text as="span" fontWeight="medium">
          {condition.label}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={condition.action === "DENY" ? "critical" : "success"}>
          {condition.action === "DENY" ? "Denies return" : "Proceeds"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={condition.isActive ? "success" : undefined}>
          {condition.isActive ? "Active" : "Inactive"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span onClick={(e) => e.stopPropagation()}>
          <Button variant="plain" tone="critical" onClick={() => remove(condition.id)}>
            Delete
          </Button>
        </span>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Item condition options">
        <button variant="primary" onClick={openNew}>
          Add condition
        </button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "condition", plural: "conditions" }}
              itemCount={conditions.length}
              headings={[
                { title: "Label" },
                { title: "Behavior" },
                { title: "Status" },
                { title: "" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
            {conditions.length === 0 && (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No condition options yet. Add one to get started.
                </Text>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? "Edit condition" : "Add condition"}
        primaryAction={{
          content: "Save",
          onAction: submit,
          loading: fetcher.state === "submitting",
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Label shown to customers"
              value={form.label}
              onChange={(label) => setForm((f) => ({ ...f, label }))}
              autoComplete="off"
            />
            <TextField
              label="Internal code"
              helpText="Stable identifier, e.g. slightly_used"
              value={form.code}
              onChange={(code) => setForm((f) => ({ ...f, code }))}
              autoComplete="off"
            />
            <Select
              label="Behavior"
              options={[
                { label: "Proceed with return", value: "PROCEED" },
                { label: "Deny the return", value: "DENY" },
              ]}
              value={form.action}
              onChange={(action) => setForm((f) => ({ ...f, action }))}
            />
            {form.action === "DENY" && (
              <>
                <TextField
                  label="Denial message"
                  value={form.denyMessage}
                  onChange={(denyMessage) => setForm((f) => ({ ...f, denyMessage }))}
                  multiline={3}
                  autoComplete="off"
                />
                <TextField
                  label="Return policy link (optional)"
                  value={form.denyLinkUrl}
                  onChange={(denyLinkUrl) => setForm((f) => ({ ...f, denyLinkUrl }))}
                  autoComplete="off"
                />
              </>
            )}
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
