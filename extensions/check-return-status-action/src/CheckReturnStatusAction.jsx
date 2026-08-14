import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
};

// Deep-links straight to the app's App Proxy return-status page. App Proxy
// routes only resolve against the storefront's own primary domain (never
// the customer-account host this extension actually runs on), so the
// button stays hidden until that domain is resolved via the Storefront API.
function Extension() {
  const [href, setHref] = useState(null);

  useEffect(() => {
    shopify
      .query(`query ShopPrimaryDomain { shop { primaryDomain { url } } }`)
      .then(({ data }) => {
        const base = data?.shop?.primaryDomain?.url;
        if (base) setHref(`${base}/apps/returns/status`);
      })
      .catch(() => {});
  }, []);

  if (!href) return null;

  return (
    <s-button href={href} target="_blank">
      {shopify.i18n.translate('checkReturnStatus')}
    </s-button>
  );
}
