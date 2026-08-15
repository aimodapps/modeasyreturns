import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

export type CatalogVariant = {
  id: string;
  title: string;
  // Money in the shop's default currency (Shopify's `price` field carries no
  // currency of its own) -- assume same currency as the original order line,
  // reasonable for a single-currency single-shop app.
  price: string;
  availableForSale: boolean;
};

export type CatalogProduct = {
  id: string;
  title: string;
  imageUrl: string | null;
  variants: CatalogVariant[];
};

const PRODUCT_FIELDS = `#graphql
  fragment CatalogProductFields on Product {
    id
    title
    featuredImage {
      url
    }
    variants(first: 25) {
      nodes {
        id
        title
        availableForSale
        price
      }
    }
  }
`;

// Shopify's "published_status:published" search-query filter is documented
// as unreliable for this (Shopify's own community has reported it still
// returning unpublished products), so eligibility is instead checked on the
// field itself: onlineStoreUrl is null precisely when a product isn't
// published to the Online Store sales channel -- e.g. POS-only products.
const SEARCH_PRODUCTS_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query SearchCatalogProducts($query: String!) {
    products(first: 25, query: $query) {
      nodes {
        ...CatalogProductFields
        onlineStoreUrl
      }
    }
  }
`;

const PRODUCTS_BY_ID_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query CatalogProductsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        ...CatalogProductFields
      }
    }
  }
`;

function toCatalogProduct(node: any): CatalogProduct {
  return {
    id: node.id,
    title: node.title,
    imageUrl: node.featuredImage?.url ?? null,
    variants: (node.variants?.nodes ?? []).map((v: any) => ({
      id: v.id,
      title: v.title,
      price: v.price,
      availableForSale: v.availableForSale,
    })),
  };
}

export async function searchCatalogProducts(
  admin: AdminApiContext,
  searchTerm: string,
): Promise<CatalogProduct[]> {
  const sanitized = searchTerm.trim().replace(/["\\]/g, "");
  if (!sanitized) return [];

  const response = await admin.graphql(SEARCH_PRODUCTS_QUERY, {
    variables: { query: `title:*${sanitized}* status:active` },
  });
  const json: any = await response.json();
  const nodes = json?.data?.products?.nodes ?? [];
  return nodes
    .filter((node: any) => node.onlineStoreUrl)
    .slice(0, 12)
    .map(toCatalogProduct);
}

const VARIANT_BY_ID_QUERY = `#graphql
  query CatalogVariantById($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        price
        availableForSale
        product {
          id
          title
          featuredImage {
            url
          }
          onlineStoreUrl
        }
      }
    }
  }
`;

export type CatalogVariantWithProduct = CatalogVariant & {
  productId: string;
  productTitle: string;
  productImageUrl: string | null;
};

/**
 * Always re-fetches the variant's price live from Shopify -- never trust a
 * client-submitted price for a money calculation. Also re-checks Online
 * Store publication server-side (not just at search time) in case a variant
 * ID for a POS-only product is ever submitted directly.
 */
export async function getVariantById(
  admin: AdminApiContext,
  variantId: string,
): Promise<CatalogVariantWithProduct | null> {
  const response = await admin.graphql(VARIANT_BY_ID_QUERY, { variables: { id: variantId } });
  const json: any = await response.json();
  const node = json?.data?.node;
  if (!node || !node.product?.onlineStoreUrl) return null;

  return {
    id: node.id,
    title: node.title,
    price: node.price,
    availableForSale: node.availableForSale,
    productId: node.product.id,
    productTitle: node.product.title,
    productImageUrl: node.product.featuredImage?.url ?? null,
  };
}

export async function getCatalogProductsByIds(
  admin: AdminApiContext,
  productIds: string[],
): Promise<CatalogProduct[]> {
  if (productIds.length === 0) return [];

  const response = await admin.graphql(PRODUCTS_BY_ID_QUERY, {
    variables: { ids: productIds },
  });
  const json: any = await response.json();
  const nodes = (json?.data?.nodes ?? []).filter(Boolean);
  return nodes.map(toCatalogProduct);
}
