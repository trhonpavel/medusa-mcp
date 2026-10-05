import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/helpers.js";
import { loadStoreInfo } from "./tools/store.js";
import { loadOrderDetail } from "./tools/orders.js";
import { loadProductDetail } from "./tools/products.js";
import { loadCustomerDetail } from "./tools/customers.js";

const json = (uri: URL, data: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, (_k, v) => (v === null ? undefined : v)) }],
});
const one = (v: string | string[]) => decodeURIComponent(Array.isArray(v) ? v[0] : v);

/**
 * Resources let clients attach store data to a conversation (e.g. @-mentions in Claude Code),
 * with completion of order numbers, product handles and customer e-mails.
 */
export function registerResources(server: McpServer, ctx: ToolContext) {
  const { medusa } = ctx;
  const safe = async (fn: () => Promise<string[]>) => {
    try {
      return (await fn()).slice(0, 20);
    } catch {
      return [];
    }
  };

  server.registerResource(
    "store",
    "medusa://store",
    { title: "Store overview", description: "Regions, sales channels, stock locations, shipping options", mimeType: "application/json" },
    async (uri) => json(uri, await loadStoreInfo(ctx)),
  );

  server.registerResource(
    "order",
    new ResourceTemplate("medusa://orders/{order}", {
      list: async () => {
        const res = await medusa.get("/admin/orders", {
          fields: "id,display_id,email,total,currency_code,created_at",
          order: "-created_at",
          limit: 25,
        });
        return {
          resources: (res.orders ?? []).map((o: any) => ({
            uri: `medusa://orders/${o.display_id}`,
            name: `Order #${o.display_id}`,
            description: `${o.email ?? ""} · ${o.total} ${(o.currency_code ?? "").toUpperCase()} · ${String(o.created_at).slice(0, 10)}`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        order: (value) =>
          safe(async () => {
            const res = await medusa.get("/admin/orders", {
              fields: "id,display_id",
              order: "-created_at",
              q: value || undefined,
              limit: 20,
            });
            return (res.orders ?? []).map((o: any) => String(o.display_id)).filter((n: string) => n.startsWith(value));
          }),
      },
    }),
    { title: "Order", description: "Order detail by order number, e.g. medusa://orders/1042", mimeType: "application/json" },
    async (uri, vars) => json(uri, await loadOrderDetail(ctx, one(vars.order))),
  );

  server.registerResource(
    "product",
    new ResourceTemplate("medusa://products/{product}", {
      list: undefined,
      complete: {
        product: (value) =>
          safe(async () => {
            const res = await medusa.get("/admin/products", { fields: "id,handle", q: value || undefined, order: "-updated_at", limit: 20 });
            return (res.products ?? []).map((p: any) => p.handle as string);
          }),
      },
    }),
    { title: "Product", description: "Product detail by handle or ID, e.g. medusa://products/my-product", mimeType: "application/json" },
    async (uri, vars) => json(uri, await loadProductDetail(ctx, one(vars.product))),
  );

  server.registerResource(
    "customer",
    new ResourceTemplate("medusa://customers/{customer}", {
      list: undefined,
      complete: {
        customer: (value) =>
          safe(async () => {
            const res = await medusa.get("/admin/customers", { fields: "id,email", q: value || undefined, limit: 20 });
            return (res.customers ?? []).map((c: any) => c.email as string).filter(Boolean);
          }),
      },
    }),
    { title: "Customer", description: "Customer with order history by e-mail or ID", mimeType: "application/json" },
    async (uri, vars) => json(uri, await loadCustomerDetail(ctx, one(vars.customer))),
  );
}
