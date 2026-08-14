import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/StartReturnAction.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order.action.menu-item.render').Api;
  const globalThis: { shopify: typeof shopify };
}
