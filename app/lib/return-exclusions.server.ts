import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { ReturnableItem } from "./shopify-admin.server";

export type CatalogCollection = {
  id: string;
  title: string;
  imageUrl: string | null;
};

const COLLECTION_FIELDS = `#graphql
  fragment CatalogCollectionFields on Collection {
    id
    title
    image {
      url
    }
  }
`;

const SEARCH_COLLECTIONS_QUERY = `#graphql
  ${COLLECTION_FIELDS}
  query SearchCatalogCollections($query: String!) {
    collections(first: 12, query: $query) {
      nodes {
        ...CatalogCollectionFields
      }
    }
  }
`;

const COLLECTIONS_BY_ID_QUERY = `#graphql
  ${COLLECTION_FIELDS}
  query CatalogCollectionsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Collection {
        ...CatalogCollectionFields
      }
    }
  }
`;

function toCatalogCollection(node: any): CatalogCollection {
  return { id: node.id, title: node.title, imageUrl: node.image?.url ?? null };
}

export async function searchCatalogCollections(
  admin: AdminApiContext,
  searchTerm: string,
): Promise<CatalogCollection[]> {
  const sanitized = searchTerm.trim().replace(/["\\]/g, "");
  if (!sanitized) return [];

  const response = await admin.graphql(SEARCH_COLLECTIONS_QUERY, {
    variables: { query: `title:*${sanitized}*` },
  });
  const json: any = await response.json();
  return (json?.data?.collections?.nodes ?? []).map(toCatalogCollection);
}

export async function getCatalogCollectionsByIds(
  admin: AdminApiContext,
  ids: string[],
): Promise<CatalogCollection[]> {
  if (ids.length === 0) return [];
  const response = await admin.graphql(COLLECTIONS_BY_ID_QUERY, { variables: { ids } });
  const json: any = await response.json();
  return (json?.data?.nodes ?? []).filter(Boolean).map(toCatalogCollection);
}

export type ReturnExclusionRule = {
  type: "PRODUCT" | "COLLECTION";
  shopifyResourceId: string;
};

/**
 * Splits Shopify's returnable items into what's actually selectable vs. what
 * this shop has separately marked non-returnable (final sale) via product or
 * collection ID -- see the comment on getReturnableItems for why this can't
 * just be deferred to Shopify's own return rules.
 */
export function splitByExclusionRules(
  items: ReturnableItem[],
  exclusions: ReturnExclusionRule[],
): { eligible: ReturnableItem[]; excluded: ReturnableItem[] } {
  if (exclusions.length === 0) return { eligible: items, excluded: [] };

  const excludedProductIds = new Set(
    exclusions.filter((e) => e.type === "PRODUCT").map((e) => e.shopifyResourceId),
  );
  const excludedCollectionIds = new Set(
    exclusions.filter((e) => e.type === "COLLECTION").map((e) => e.shopifyResourceId),
  );

  const eligible: ReturnableItem[] = [];
  const excluded: ReturnableItem[] = [];
  for (const item of items) {
    const isExcluded =
      (item.productId && excludedProductIds.has(item.productId)) ||
      item.collectionIds.some((id) => excludedCollectionIds.has(id));
    (isExcluded ? excluded : eligible).push(item);
  }
  return { eligible, excluded };
}
