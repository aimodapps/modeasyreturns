import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Link as RemixLink } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Badge, Text, Box } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const STATUS_TONE: Record<string, "attention" | "success" | "critical" | undefined> = {
  PENDING_REVIEW: "attention",
  APPROVED: "success",
  DENIED: "critical",
  CANCELLED: undefined,
  DRAFT: undefined,
};

const STAGE_LABELS: Record<string, string> = {
  AWAITING_RECEIPT: "Awaiting receipt",
  BALANCE_DUE: "Balance due",
  INVOICE_SENT: "Invoice sent",
  COMPLETED: "Completed",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const requests = await db.returnRequest.findMany({
    where: { shopDomain: session.shop, status: { not: "DRAFT" } },
    include: { lineItems: true },
    orderBy: { submittedAt: "desc" },
    take: 100,
  });
  return { requests };
};

export default function ReturnsQueue() {
  const { requests } = useLoaderData<typeof loader>();

  const rowMarkup = requests.map((request, index) => (
    <IndexTable.Row id={request.id} key={request.id} position={index}>
      <IndexTable.Cell>
        <RemixLink to={`/app/returns/${request.id}`}>
          <Text as="span" fontWeight="medium">
            {request.orderName}
          </Text>
        </RemixLink>
      </IndexTable.Cell>
      <IndexTable.Cell>{request.customerEmail ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{request.lineItems.length} item(s)</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={STATUS_TONE[request.status]}>
          {request.status === "APPROVED" && request.lifecycleStage
            ? STAGE_LABELS[request.lifecycleStage]
            : request.status.replace("_", " ")}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {request.submittedAt ? new Date(request.submittedAt).toLocaleString() : "—"}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Return requests" />
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "return request", plural: "return requests" }}
              itemCount={requests.length}
              headings={[
                { title: "Order" },
                { title: "Customer" },
                { title: "Items" },
                { title: "Status" },
                { title: "Submitted" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
            {requests.length === 0 && (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No return requests yet.
                </Text>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
