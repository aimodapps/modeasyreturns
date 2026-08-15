import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

export default function App() {
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
        <link rel="icon" href="https://modfragrances.com/cdn/shop/files/favicon.png?crop=center&height=32&v=1690343853&width=32" />
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
