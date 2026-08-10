import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

  if (topic === "SHOP_REDACT") {
    await db.shopSettings.deleteMany({ where: { shopDomain: shop } });
  }

  return new Response();
};
