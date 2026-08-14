import db from "../db.server";

export type PortalBranding = {
  logoUrl: string | null;
  logoWidthPx: number | null;
  pageTitle: string | null;
  introDescription: string | null;
  orderNumberPlaceholder: string;
};

const DEFAULT_ORDER_NUMBER_PLACEHOLDER = "#1001";

export async function getPortalBranding(shopDomain: string): Promise<PortalBranding> {
  const settings = await db.shopSettings.findUnique({ where: { shopDomain } });
  return {
    logoUrl: settings?.logoUrl ?? null,
    logoWidthPx: settings?.logoWidthPx ?? null,
    pageTitle: settings?.pageTitle ?? null,
    introDescription: settings?.introDescription ?? null,
    orderNumberPlaceholder: settings?.orderNumberPlaceholder || DEFAULT_ORDER_NUMBER_PLACEHOLDER,
  };
}
