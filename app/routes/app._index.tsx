import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, Link as RemixLink } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Box,
  Select,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const RANGE_OPTIONS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "Last 365 days", value: "365" },
  { label: "All time", value: "all" },
];

const STAGE_LABELS: Record<string, string> = {
  AWAITING_RECEIPT: "Awaiting receipt",
  BALANCE_DUE: "Balance due",
  INVOICE_SENT: "Invoice sent",
  COMPLETED: "Completed",
};

const STATUS_TONE: Record<string, "attention" | "success" | "critical" | undefined> = {
  PENDING_REVIEW: "attention",
  APPROVED: "success",
  DENIED: "critical",
  CANCELLED: undefined,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range") ?? "30";
  const days = rangeParam === "all" ? null : Number(rangeParam);
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  // Everything below is one cohort: requests SUBMITTED within the selected
  // range, classified by their current status/lifecycle -- keeps "received"
  // vs "approved" vs "declined" numbers internally consistent instead of
  // mixing submittedAt- and decidedAt-scoped counts that could disagree.
  const requestsInRange = await db.returnRequest.findMany({
    where: { shopDomain, status: { not: "DRAFT" }, submittedAt: since ? { gte: since } : { not: null } },
    include: { lineItems: { include: { reason: true, exchangeSelection: true } } },
  });

  const received = requestsInRange.length;
  const approved = requestsInRange.filter((r) => r.status === "APPROVED").length;
  const declined = requestsInRange.filter((r) => r.status === "DENIED").length;
  const stillPending = requestsInRange.filter((r) => r.status === "PENDING_REVIEW").length;
  const decided = approved + declined;
  const approvalRate = decided > 0 ? Math.round((approved / decided) * 100) : null;

  const refundTotal = requestsInRange.reduce((sum, r) => sum + (r.refundIssuedAmount ? Number(r.refundIssuedAmount) : 0), 0);
  const currencyCode = requestsInRange.find((r) => r.lineItems[0])?.lineItems[0]?.currencyCode ?? "USD";

  const exchangeCount = requestsInRange.filter((r) => r.lineItems.some((li) => li.exchangeSelection)).length;
  const plainReturnCount = received - exchangeCount;

  const reasonCounts = new Map<string, number>();
  for (const r of requestsInRange) {
    for (const li of r.lineItems) {
      const label = li.reason?.label ?? "Unspecified";
      reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));

  // No productId is stored on ReturnRequestLineItem (only the title/variant
  // snapshotted at return time), so products are grouped by title+variant
  // text -- fine in practice since product names are stable and distinct.
  const productCounts = new Map<string, { title: string; variantTitle: string | null; quantity: number; requests: number }>();
  for (const r of requestsInRange) {
    for (const li of r.lineItems) {
      const key = `${li.title}::${li.variantTitle ?? ""}`;
      const existing = productCounts.get(key);
      if (existing) {
        existing.quantity += li.quantity;
        existing.requests += 1;
      } else {
        productCounts.set(key, { title: li.title, variantTitle: li.variantTitle, quantity: li.quantity, requests: 1 });
      }
    }
  }
  const topProducts = [...productCounts.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);

  const REPEAT_RETURNER_THRESHOLD = 3;
  const [
    pendingReviewCount,
    awaitingReceiptCount,
    balanceDueCount,
    failedNotificationCount,
    shopSettings,
    activeConditionCount,
    activeReasonCount,
    recent,
    repeatReturnerGroups,
  ] = await Promise.all([
    db.returnRequest.count({ where: { shopDomain, status: "PENDING_REVIEW" } }),
    db.returnRequest.count({ where: { shopDomain, status: "APPROVED", lifecycleStage: "AWAITING_RECEIPT" } }),
    db.returnRequest.count({ where: { shopDomain, status: "APPROVED", lifecycleStage: "BALANCE_DUE" } }),
    db.adminNotificationLog.count({ where: { status: "FAILED", returnRequest: { shopDomain } } }),
    db.shopSettings.findUnique({ where: { shopDomain } }),
    db.conditionOption.count({ where: { shopDomain, isActive: true } }),
    db.returnReason.count({ where: { shopDomain, isActive: true } }),
    db.returnRequest.findMany({
      where: { shopDomain, status: { not: "DRAFT" } },
      orderBy: { submittedAt: "desc" },
      take: 8,
      select: { id: true, orderName: true, customerEmail: true, status: true, lifecycleStage: true, submittedAt: true },
    }),
    // All-time, not range-scoped -- repeat-returner status is a customer
    // trait, not something that should reset just because a shorter date
    // range is selected.
    db.returnRequest.groupBy({
      by: ["customerEmail"],
      where: { shopDomain, status: { not: "DRAFT" }, customerEmail: { not: null } },
      _count: { customerEmail: true },
      having: { customerEmail: { _count: { gte: REPEAT_RETURNER_THRESHOLD } } },
      orderBy: { _count: { customerEmail: "desc" } },
      take: 10,
    }),
  ]);

  const repeatReturners = repeatReturnerGroups.map((g) => ({
    email: g.customerEmail as string,
    count: g._count.customerEmail,
  }));

  return {
    range: rangeParam,
    received,
    approved,
    declined,
    stillPending,
    approvalRate,
    refundTotal,
    currencyCode,
    exchangeCount,
    plainReturnCount,
    topReasons,
    topProducts,
    repeatReturners,
    todos: {
      pendingReviewCount,
      awaitingReceiptCount,
      balanceDueCount,
      failedNotificationCount,
      needsSupportEmail: !shopSettings?.supportEmail,
      needsConditions: activeConditionCount === 0,
      needsReasons: activeReasonCount === 0,
    },
    recent,
  };
};

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: "1 1 200px", minWidth: 200 }}>
      <Card>
        <BlockStack gap="100">
          <Text as="span" tone="subdued" variant="bodySm">
            {label}
          </Text>
          <Text as="span" variant="heading2xl">
            {value}
          </Text>
          {sub && (
            <Text as="span" tone="subdued" variant="bodySm">
              {sub}
            </Text>
          )}
        </BlockStack>
      </Card>
    </div>
  );
}

function TodoRow({ count, label, url }: { count: number; label: string; url: string }) {
  if (count === 0) return null;
  return (
    <RemixLink to={url} style={{ textDecoration: "none" }}>
      <Box padding="300" borderRadius="200" background="bg-surface-secondary">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span">{label}</Text>
          <Badge tone="attention">{String(count)}</Badge>
        </InlineStack>
      </Box>
    </RemixLink>
  );
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const setRange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", value);
    navigate(`/app?${next.toString()}`);
  };

  const { todos } = data;
  const hasSetupNudges = todos.needsSupportEmail || todos.needsConditions || todos.needsReasons;
  const hasTodos =
    todos.pendingReviewCount > 0 ||
    todos.awaitingReceiptCount > 0 ||
    todos.balanceDueCount > 0 ||
    todos.failedNotificationCount > 0 ||
    hasSetupNudges;

  return (
    <Page>
      <TitleBar title="Dashboard" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <InlineStack align="end">
              <Box minWidth="200px">
                <Select label="Date range" labelHidden options={RANGE_OPTIONS} value={data.range} onChange={setRange} />
              </Box>
            </InlineStack>
          </Layout.Section>

          <Layout.Section>
            <InlineStack gap="400" wrap>
              <KpiCard label="Returns received" value={String(data.received)} />
              <KpiCard
                label="Approved"
                value={String(data.approved)}
                sub={data.approvalRate != null ? `${data.approvalRate}% approval rate` : undefined}
              />
              <KpiCard label="Declined" value={String(data.declined)} />
              <KpiCard label="Refunded" value={`${data.refundTotal.toFixed(2)} ${data.currencyCode}`} />
            </InlineStack>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  To do
                </Text>
                {!hasTodos && (
                  <Text as="p" tone="subdued">
                    Nothing needs your attention right now.
                  </Text>
                )}
                <TodoRow count={todos.pendingReviewCount} label="Return requests awaiting your decision" url="/app/returns?status=PENDING_REVIEW" />
                <TodoRow
                  count={todos.awaitingReceiptCount}
                  label="Approved returns waiting to be received & inspected"
                  url="/app/returns?stage=AWAITING_RECEIPT"
                />
                <TodoRow count={todos.balanceDueCount} label="Exchanges with a balance due -- ready to invoice" url="/app/returns?stage=BALANCE_DUE" />
                <TodoRow count={todos.failedNotificationCount} label="Customer notification emails failed to send" url="/app/returns" />
                {todos.needsSupportEmail && (
                  <RemixLink to="/app/settings/general" style={{ textDecoration: "none" }}>
                    <Box padding="300" borderRadius="200" background="bg-surface-secondary">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="warning">Setup</Badge>
                        <Text as="span">No admin notification email set -- you won't be emailed about new requests.</Text>
                      </InlineStack>
                    </Box>
                  </RemixLink>
                )}
                {todos.needsConditions && (
                  <RemixLink to="/app/settings/conditions" style={{ textDecoration: "none" }}>
                    <Box padding="300" borderRadius="200" background="bg-surface-secondary">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="warning">Setup</Badge>
                        <Text as="span">No active item conditions configured -- the customer wizard needs at least one.</Text>
                      </InlineStack>
                    </Box>
                  </RemixLink>
                )}
                {todos.needsReasons && (
                  <RemixLink to="/app/settings/reasons" style={{ textDecoration: "none" }}>
                    <Box padding="300" borderRadius="200" background="bg-surface-secondary">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="warning">Setup</Badge>
                        <Text as="span">No active return reasons configured -- the customer wizard needs at least one.</Text>
                      </InlineStack>
                    </Box>
                  </RemixLink>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Top return reasons
                </Text>
                {data.topReasons.length === 0 && (
                  <Text as="p" tone="subdued">
                    No returns in this range yet.
                  </Text>
                )}
                {data.topReasons.map((r) => (
                  <InlineStack key={r.label} align="space-between">
                    <Text as="span">{r.label}</Text>
                    <Text as="span" tone="subdued">
                      {r.count}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Returns vs. exchanges
                </Text>
                <InlineStack align="space-between">
                  <Text as="span">Plain returns</Text>
                  <Text as="span" tone="subdued">
                    {data.plainReturnCount}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Exchanges</Text>
                  <Text as="span" tone="subdued">
                    {data.exchangeCount}
                  </Text>
                </InlineStack>
                {data.stillPending > 0 && (
                  <Text as="p" tone="subdued">
                    {data.stillPending} of the requests received in this range are still awaiting a decision.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Top returned products
                </Text>
                <Text as="p" tone="subdued">
                  Grouped by product/variant title, this range.
                </Text>
                {data.topProducts.length === 0 && (
                  <Text as="p" tone="subdued">
                    No returns in this range yet.
                  </Text>
                )}
                {data.topProducts.map((p) => (
                  <InlineStack key={`${p.title}::${p.variantTitle ?? ""}`} align="space-between">
                    <Text as="span">
                      {p.title}
                      {p.variantTitle ? ` — ${p.variantTitle}` : ""}
                    </Text>
                    <Text as="span" tone="subdued">
                      {p.quantity} unit{p.quantity === 1 ? "" : "s"}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Repeat returners
                </Text>
                <Text as="p" tone="subdued">
                  Customers with 3+ return requests all-time -- not limited to the selected range.
                </Text>
                {data.repeatReturners.length === 0 && (
                  <Text as="p" tone="subdued">
                    No customers have returned 3 or more times yet.
                  </Text>
                )}
                {data.repeatReturners.map((c) => (
                  <RemixLink key={c.email} to={`/app/returns?email=${encodeURIComponent(c.email)}`} style={{ textDecoration: "none" }}>
                    <InlineStack align="space-between">
                      <Text as="span">{c.email}</Text>
                      <Badge tone="warning">{`${c.count} requests`}</Badge>
                    </InlineStack>
                  </RemixLink>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <Text as="h2" variant="headingMd">
                  Recent activity
                </Text>
              </Box>
              <BlockStack gap="0">
                {data.recent.length === 0 && (
                  <Box padding="400">
                    <Text as="p" tone="subdued">
                      No return requests yet.
                    </Text>
                  </Box>
                )}
                {data.recent.map((r) => (
                  <Box key={r.id} padding="300" borderBlockStartWidth="025" borderColor="border">
                    <RemixLink to={`/app/returns/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="300" blockAlign="center">
                          <Text as="span" fontWeight="medium">
                            {r.orderName}
                          </Text>
                          <Text as="span" tone="subdued">
                            {r.customerEmail ?? "—"}
                          </Text>
                        </InlineStack>
                        <InlineStack gap="300" blockAlign="center">
                          <Badge tone={STATUS_TONE[r.status]}>
                            {r.status === "APPROVED" && r.lifecycleStage ? STAGE_LABELS[r.lifecycleStage] : r.status.replace("_", " ")}
                          </Badge>
                          <Text as="span" tone="subdued">
                            {r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : "—"}
                          </Text>
                        </InlineStack>
                      </InlineStack>
                    </RemixLink>
                  </Box>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
