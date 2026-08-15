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
  type: "PRODUCT" | "COLLECTION" | "LINE_ITEM_TAG";
  shopifyResourceId: string;
};

const COLLECTION_PRODUCT_IDS_QUERY = `#graphql
  query CollectionProductIds($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * Resolves the shop's exclusion rules down to a flat set of excluded
 * product IDs -- collection-based rules are expanded by fetching that
 * collection's own member products, rather than checking each returnable
 * item's OWN collection membership (Product.collections). The latter would
 * need to be capped at some page size per product and can silently miss a
 * match for any product that belongs to more collections than that cap --
 * a real risk for products already organized into several collections.
 * This direction is bounded by the shop's (typically small, deliberately
 * configured) exclusion list instead of a product's unbounded collection
 * membership, and can't silently drop a match that way.
 */
export async function getExcludedProductIds(
  admin: AdminApiContext,
  exclusions: ReturnExclusionRule[],
): Promise<Set<string>> {
  const excludedProductIds = new Set(
    exclusions.filter((e) => e.type === "PRODUCT").map((e) => e.shopifyResourceId),
  );

  const collectionIds = exclusions.filter((e) => e.type === "COLLECTION").map((e) => e.shopifyResourceId);
  for (const collectionId of collectionIds) {
    let cursor: string | null = null;
    do {
      const response: Response = await admin.graphql(COLLECTION_PRODUCT_IDS_QUERY, {
        variables: { id: collectionId, cursor },
      });
      const json: any = await response.json();
      const products = json?.data?.collection?.products;
      for (const node of products?.nodes ?? []) {
        if (node?.id) excludedProductIds.add(node.id);
      }
      cursor = products?.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
    } while (cursor);
  }

  return excludedProductIds;
}

/** LINE_ITEM_TAG rules need no API call -- the configured text is matched directly against each line item's own custom attributes at split time. */
export function getExcludedLineItemTags(exclusions: ReturnExclusionRule[]): string[] {
  return exclusions.filter((e) => e.type === "LINE_ITEM_TAG").map((e) => e.shopifyResourceId.toLowerCase());
}

/**
 * Splits Shopify's returnable items into what's actually selectable vs. what
 * this shop has separately marked non-returnable (final sale) -- either by
 * product/collection ID, or by a line item's own custom attributes (what
 * bundle-builder apps use to mark a specific purchase as part of a bundle,
 * distinct from the product itself, which may still be returnable when
 * bought standalone). See the comment on getReturnableItems for why this
 * can't just be deferred to Shopify's own return rules.
 */
export function splitByExclusionRules(
  items: ReturnableItem[],
  excludedProductIds: Set<string>,
  excludedLineItemTags: string[] = [],
): { eligible: ReturnableItem[]; excluded: ReturnableItem[] } {
  if (excludedProductIds.size === 0 && excludedLineItemTags.length === 0) {
    return { eligible: items, excluded: [] };
  }

  const eligible: ReturnableItem[] = [];
  const excluded: ReturnableItem[] = [];
  for (const item of items) {
    const isExcludedByProduct = Boolean(item.productId && excludedProductIds.has(item.productId));
    const isExcludedByTag = excludedLineItemTags.some((tag) =>
      item.tagCandidates.some((candidate) => candidate.toLowerCase().includes(tag)),
    );
    (isExcludedByProduct || isExcludedByTag ? excluded : eligible).push(item);
  }
  return { eligible, excluded };
}
