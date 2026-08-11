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
  Checkbox,
  Box,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const reasons = await db.returnReason.findMany({
    where: { shopDomain: session.shop },
    orderBy: { sortOrder: "asc" },
  });
  return { reasons };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "delete") {
    const id = String(formData.get("id"));
    await db.returnReason.deleteMany({ where: { id, shopDomain: session.shop } });
    return { ok: true };
  }

  const id = formData.get("id") ? String(formData.get("id")) : null;
  const label = String(formData.get("label") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();
  const isActive = formData.get("isActive") === "true";

  if (!label || !code || !message) {
    return { ok: false, error: "Label, code, and message are required." };
  }

  const data = { label, code, message, isActive } as const;

  if (id) {
    await db.returnReason.update({ where: { id }, data });
  } else {
    const count = await db.returnReason.count({ where: { shopDomain: session.shop } });
    await db.returnReason.create({
      data: { ...data, shopDomain: session.shop, sortOrder: count },
    });
  }

  return { ok: true };
};

type ReasonRow = Awaited<ReturnType<typeof useLoaderData<typeof loader>>>["reasons"][number];

const EMPTY_FORM = {
  id: "",
  label: "",
  code: "",
  message: "",
  isActive: true,
};

export default function ReasonsSettings() {
  const { reasons } = useLoaderData<typeof loader>();
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

  const openEdit = (reason: ReasonRow) => {
    setForm({
      id: reason.id,
      label: reason.label,
      code: reason.code,
      message: reason.message,
      isActive: reason.isActive,
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
        message: form.message,
        isActive: String(form.isActive),
      },
      { method: "post" },
    );
  };

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete", id }, { method: "post" });
  };

  const rowMarkup = reasons.map((reason, index) => (
    <IndexTable.Row id={reason.id} key={reason.id} position={index} onClick={() => openEdit(reason)}>
      <IndexTable.Cell>
        <Text as="span" fontWeight="medium">
          {reason.label}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={reason.isActive ? "success" : undefined}>
          {reason.isActive ? "Active" : "Inactive"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span onClick={(e) => e.stopPropagation()}>
          <Button variant="plain" tone="critical" onClick={() => remove(reason.id)}>
            Delete
          </Button>
        </span>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Return & exchange reasons">
        <button variant="primary" onClick={openNew}>
          Add reason
        </button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "reason", plural: "reasons" }}
              itemCount={reasons.length}
              headings={[
                { title: "Label" },
                { title: "Status" },
                { title: "" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
            {reasons.length === 0 && (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No reasons yet. Add one to get started.
                </Text>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? "Edit reason" : "Add reason"}
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
              helpText="Stable identifier, e.g. broken_during_transit"
              value={form.code}
              onChange={(code) => setForm((f) => ({ ...f, code }))}
              autoComplete="off"
            />
            <TextField
              label="Message shown when this reason is selected"
              value={form.message}
              onChange={(message) => setForm((f) => ({ ...f, message }))}
              multiline={5}
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
