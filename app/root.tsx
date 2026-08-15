import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "@remix-run/react";

// The customer-facing pages under /apps/returns/* are reached through
// Shopify's App Proxy, so a plain root-relative href like "/favicon.ico"
// resolves against the storefront domain (modfragrances.com), not this app
// -- only paths actually prefixed with /apps/returns get proxied back to
// us. An absolute URL to our own app host is the only way a static asset
// like the favicon resolves correctly on those pages.
export const loader = async (_args: LoaderFunctionArgs) => {
  return { appUrl: process.env.SHOPIFY_APP_URL || "" };
};

export default function App() {
  const { appUrl } = useLoaderData<typeof loader>();

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Mod Easy Returns</title>
        <meta
          name="description"
          content="Start a return or exchange for your Mod Fragrances order."
        />
        {/* Transactional/order-lookup pages have no SEO value and shouldn't be indexed. */}
        <meta name="robots" content="noindex, nofollow" />
        {appUrl && <link rel="icon" href={`${appUrl}/favicon.ico`} />}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
