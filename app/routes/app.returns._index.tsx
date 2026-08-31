import { useCallback, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, Link as RemixLink } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  Box,
  InlineStack,
  Tabs,
  TextField,
  Button,
  Pagination,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import type { ReturnStatus, ReturnLifecycleStage } from "@prisma/client";
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

const VALID_STATUSES: ReturnStatus[] = ["PENDING_REVIEW", "APPROVED", "DENIED", "CANCELLED"];
const VALID_STAGES: ReturnLifecycleStage[] = ["AWAITING_RECEIPT", "BALANCE_DUE", "INVOICE_SENT", "COMPLETED"];

const PAGE_SIZE = 20;

type StatusTab = {
  id: string;
  label: string;
  status: ReturnStatus | null;
  stage: ReturnLifecycleStage | null;
};

// "Completed" is a lifecycle sub-state of APPROVED rather than its own
// ReturnStatus, so that tab pins both status and stage together.
const STATUS_TABS: StatusTab[] = [
  { id: "all", label: "All", status: null, stage: null },
  { id: "pending", label: "Pending review", status: "PENDING_REVIEW", stage: null },
  { id: "approved", label: "Approved", status: "APPROVED", stage: null },
  { id: "completed", label: "Completed", status: "APPROVED", stage: "COMPLETED" },
  { id: "denied", label: "Denied", status: "DENIED", stage: null },
  { id: "cancelled", label: "Cancelled", status: "CANCELLED", stage: null },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const stageParam = url.searchParams.get("stage");
  // `email` is kept for backward compatibility with existing dashboard links;
  // `q` is the general order/email search box.
  const qParam = url.searchParams.get("q") ?? url.searchParams.get("email");
  const pageParam = Number(url.searchParams.get("page") ?? "1");

  const statusFilter = VALID_STATUSES.find((s) => s === statusParam) ?? null;
  const stageFilter = VALID_STAGES.find((s) => s === stageParam) ?? null;
  const query = qParam?.trim() || null;
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const requests = await db.returnRequest.findMany({
    where: {
      shopDomain: session.shop,
      status: statusFilter ?? { not: "DRAFT" },
      lifecycleStage: stageFilter ?? undefined,
      ...(query
        ? {
            OR: [
              { orderName: { contains: query, mode: "insensitive" as const } },
              { customerEmail: { contains: query, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    include: { lineItems: true },
    orderBy: { submittedAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    // Fetch one extra row to detect a next page without a separate count query.
    take: PAGE_SIZE + 1,
  });

  const hasNextPage = requests.length > PAGE_SIZE;
  const pageItems = hasNextPage ? requests.slice(0, PAGE_SIZE) : requests;

  return {
    requests: pageItems,
    statusFilter,
    stageFilter,
    query,
    page,
    hasNextPage,
    hasPreviousPage: page > 1,
  };
};

export default function ReturnsQueue() {
  const { requests, statusFilter, stageFilter, query, page, hasNextPage, hasPreviousPage } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState(query ?? "");

  const buildUrl = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (stageFilter) params.set("stage", stageFilter);
      if (query) params.set("q", query);
      if (page > 1) params.set("page", String(page));
      for (const [key, value] of Object.entries(overrides)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      // Any filter or search change resets pagination back to page 1.
      if (!("page" in overrides)) params.delete("page");
      const qs = params.toString();
      return qs ? `/app/returns?${qs}` : "/app/returns";
    },
    [statusFilter, stageFilter, query, page],
  );

  const selectedTabIndex = (() => {
    const index = STATUS_TABS.findIndex((t) => t.status === statusFilter && t.stage === stageFilter);
    return index === -1 ? 0 : index;
  })();

  const handleTabChange = useCallback(
    (index: number) => {
      const tab = STATUS_TABS[index];
      navigate(buildUrl({ status: tab.status, stage: tab.stage }));
    },
    [buildUrl, navigate],
  );

  const handleSearchSubmit = useCallback(() => {
    navigate(buildUrl({ q: searchValue.trim() || null }));
  }, [buildUrl, navigate, searchValue]);

  const handleSearchClear = useCallback(() => {
    setSearchValue("");
    navigate(buildUrl({ q: null }));
  }, [buildUrl, navigate]);

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

  // Stage-only deep links from the dashboard (e.g. "Balance due") don't map
  // to one of the status tabs, so call that out separately.
  const stageOnlyLabel =
    stageFilter && !STATUS_TABS.some((t) => t.status === statusFilter && t.stage === stageFilter)
      ? STAGE_LABELS[stageFilter]
      : null;

  const hasActiveFilter = Boolean(query || statusFilter || stageFilter);

  return (
    <Page>
      <TitleBar title="Return requests" />
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={STATUS_TABS.map((t) => ({ id: t.id, content: t.label }))}
              selected={selectedTabIndex}
              onSelect={handleTabChange}
            />
            <Box padding="300" borderBlockEndWidth="025" borderColor="border">
              <InlineStack gap="300" blockAlign="center" wrap={false}>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSearchSubmit();
                  }}
                  style={{ flexGrow: 1, maxWidth: "360px" }}
                >
                  <TextField
                    label="Search return requests"
                    labelHidden
                    placeholder="Search by order number or email"
                    value={searchValue}
                    onChange={setSearchValue}
                    onClearButtonClick={handleSearchClear}
                    clearButton
                    autoComplete="off"
                    connectedRight={
                      <Button submit>Search</Button>
                    }
                  />
                </form>
                {stageOnlyLabel && (
                  <InlineStack gap="100" blockAlign="center">
                    <Text as="span" tone="subdued">
                      Filtered: {stageOnlyLabel}
                    </Text>
                    <RemixLink to={buildUrl({ stage: null })}>Clear</RemixLink>
                  </InlineStack>
                )}
              </InlineStack>
            </Box>
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
                  {hasActiveFilter ? "No return requests match this filter." : "No return requests yet."}
                </Text>
              </Box>
            )}
            {(hasNextPage || hasPreviousPage) && (
              <Box padding="300" borderBlockStartWidth="025" borderColor="border">
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={hasPreviousPage}
                    onPrevious={() => navigate(buildUrl({ page: String(page - 1) }))}
                    hasNext={hasNextPage}
                    onNext={() => navigate(buildUrl({ page: String(page + 1) }))}
                  />
                </InlineStack>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
