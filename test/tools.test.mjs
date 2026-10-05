import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockMedusa, MOCK_KEY } from "./mock-medusa.mjs";

let mock, client;

before(async () => {
  mock = await startMockMedusa();
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "stdio"],
      env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, REPORT_TIMEZONE: "Europe/Prague" },
      stderr: "ignore",
    }),
  );
});
after(async () => {
  await client?.close();
  mock?.server.close();
});

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
}
const lastRequest = (pred) => [...mock.log].reverse().find(pred);

test("registers all 55 tools with correct annotations", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 55);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.get_order.annotations.readOnlyHint, true);
  assert.equal(byName.cancel_order.annotations.destructiveHint, true);
  assert.equal(byName.delete_product.annotations.destructiveHint, true);
  assert.equal(byName.refund_payment.annotations.destructiveHint, true);
  assert.equal(byName.medusa_request.annotations.destructiveHint, true);
  for (const t of tools) assert.ok(t.description.length > 20, `${t.name} has a description`);
});

test("sends Basic auth with the secret key", async () => {
  const r = await call("get_store_info");
  assert.equal(r.isError, false);
  assert.equal(r.data.stock_locations[0].id, "sloc_1");
});

test("date filters respect the reporting timezone (CEST = UTC+2)", async () => {
  await call("list_orders", { created_from: "2026-09-01", created_to: "2026-09-30" });
  const req = lastRequest((e) => e.p === "/admin/orders" && e.q.includes("created_at"));
  assert.match(req.q, /created_at\[\$gte\]=2026-08-31T22:00:00\.000Z/);
  assert.match(req.q, /created_at\[\$lte\]=2026-09-30T21:59:59\.999Z/);
});

test("get_order resolves an order number", async () => {
  const r = await call("get_order", { order: "#1001" });
  assert.equal(r.data.id, "order_1");
  assert.equal(r.data.items.length, 2);
});

test("get_order keeps Medusa's default fields (no plain field in `fields`)", async () => {
  const r = await call("get_order", { order: "order_1" });
  assert.equal(r.data.display_id, 1001);
  assert.equal(r.data.total, 1210);
  assert.equal(r.data.subtotal, 1000);
  assert.equal(r.data.email, "jan@example.com");
  assert.equal(r.data.currency, "czk");
  assert.equal(r.data.items[0].total, 800);
});

test("sales_report excludes canceled orders and orders outside the local day range", async () => {
  const r = await call("sales_report", { from: "2026-09-01", to: "2026-09-30", group_by: "day" });
  assert.equal(r.data.orders_considered, 1);
  assert.equal(r.data.totals.CZK.revenue, 1210); // the canceled order with a negative total is excluded
  assert.equal(r.data.totals.CZK.items_total, 1111);
  assert.equal(r.data.totals.EUR, undefined); // 2026-09-30T22:30Z is already October in Prague
  assert.equal(r.data.top_products[0].product_id, "prod_1");
});

test("list_inventory low stock filter", async () => {
  const r = await call("list_inventory", { low_stock_threshold: 2 });
  assert.deepEqual(r.data.items.map((i) => i.sku), ["NET-1", "NEW-1"]); // NEW-1 is not stocked anywhere yet
});

test("create_fulfillment defaults to all remaining items and the only location", async () => {
  const r = await call("create_fulfillment", { order: "1001" });
  assert.equal(r.isError, false);
  const req = lastRequest((e) => e.p.endsWith("/fulfillments") && e.m === "POST");
  assert.deepEqual(req.b.items, [
    { id: "item_1", quantity: 2 },
    { id: "item_2", quantity: 1 },
  ]);
  assert.equal(req.b.location_id, "sloc_1");
});

test("create_shipment attaches tracking", async () => {
  const r = await call("create_shipment", { order: "order_1", tracking_number: "TRK1" });
  assert.equal(r.isError, false);
  const req = lastRequest((e) => e.p.endsWith("/shipments"));
  assert.equal(req.b.labels[0].tracking_number, "TRK1");
});

test("set_variant_price keeps prices with rules untouched", async () => {
  const r = await call("set_variant_price", {
    product_id: "prod_1",
    variant_id: "variant_1",
    currency_code: "CZK",
    amount: 449,
  });
  assert.equal(r.data.before, 400);
  const prices = mock.state.variant.prices;
  assert.equal(prices.find((p) => p.id === "price_czk").amount, 449);
  assert.equal(prices.find((p) => p.id === "price_czk_b2b").amount, 350);
  assert.deepEqual(prices.find((p) => p.id === "price_czk_b2b").rules, { customer_group_id: "cg_b2b" });
  assert.equal(prices.find((p) => p.id === "price_eur").amount, 17);
});

test("set_stock_level adjusts relatively and refuses negative stock", async () => {
  const ok = await call("set_stock_level", { sku: "BALL-1", adjust_by: 5 });
  assert.equal(ok.data.stocked_after, ok.data.stocked_before + 5);
  const bad = await call("set_stock_level", { sku: "BALL-1", adjust_by: -1000 });
  assert.equal(bad.isError, true);
  const untracked = await call("set_stock_level", { sku: "NO-INVENTORY", adjust_by: 1 });
  assert.equal(untracked.isError, true);
  assert.match(untracked.text, /manage_inventory/);
});

test("delete_product requires a matching title and removes the inventory item", async () => {
  const wrong = await call("delete_product", { product_id: "prod_del", confirm_title: "Something else" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /confirm_title does not match/);
  assert.equal(mock.state.productDeleted, undefined);

  const r = await call("delete_product", { product_id: "prod_del", confirm_title: "Test product" });
  assert.equal(r.isError, false);
  assert.equal(mock.state.productDeleted, true);
  assert.deepEqual(r.data.inventory_items, [{ id: "iitem_del", sku: "DEL-1", result: "deleted" }]);
  assert.ok(!mock.state.inv.some((i) => i.id === "iitem_del"));
});

test("read-only mode hides write tools", async () => {
  const ro = new Client({ name: "ro", version: "1" });
  await ro.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "stdio"],
      env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, MEDUSA_READ_ONLY: "true" },
      stderr: "ignore",
    }),
  );
  const { tools } = await ro.listTools();
  await ro.close();
  assert.equal(tools.length, 16);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
  const raw = tools.find((t) => t.name === "medusa_request");
  assert.deepEqual(raw.inputSchema.properties.method.enum, ["GET"]);
});

test("customers and products", async () => {
  const c = await call("get_customer", { customer_id: "cus_1" });
  assert.equal(c.data.stats.orders, 2); // order_1 + order_3, canceled order_2 belongs to cus_2
  assert.deepEqual(c.data.stats.total_spent, { CZK: 1210, EUR: 50 });
  assert.equal((await call("list_customers", { q: "jan" })).data.customers.length, 1);
  assert.equal((await call("list_products")).data.products[0].variants[0].sku, "BALL-1");
  const p = await call("get_product", { product_id: "prod_1" });
  assert.deepEqual(p.data.variants[0].inventory_item_ids, ["iitem_1"]);
});

test("refuses a publishable key with a clear message", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["dist/index.js", "stdio"], {
    env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: "pk_0123456789abcdef" },
    input: "",
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /publishable key/);
});

test("get_order shows payments with captures, refunds and returns", async () => {
  const r = await call("get_order", { order: "order_1" });
  assert.deepEqual(r.data.payments[0].payments[0], {
    id: "pay_1", provider: "pp_stripe", amount: 1210, currency: "czk", captured: 1210, refunded: 200, refundable: 1010, refunds: [{ amount: 200 }],
  });
  assert.deepEqual((await call("get_order", { order: "order_3" })).data.returns[0].items, [{ line_item_id: "i4", quantity: 1, received: 0 }]);
});

test("refund_payment refuses more than the refundable amount, then refunds", async () => {
  const tooMuch = await call("refund_payment", { order: "1001", amount: 1100 });
  assert.equal(tooMuch.isError, true);
  assert.match(tooMuch.text, /pay_1 1010/);
  const r = await call("refund_payment", { order: "1001", amount: 10, note: "Damaged" });
  assert.equal(r.isError, false);
  assert.deepEqual(lastRequest((e) => e.p === "/admin/payments/pay_1/refund").b, { amount: 10, note: "Damaged" });
  assert.equal(r.data.payment.refundable, 1000);
});

test("mark_order_paid uses the unpaid payment collection", async () => {
  const r = await call("mark_order_paid", { order: "order_3" });
  assert.equal(r.data.payment_collection_id, "paycol_3");
  assert.equal(r.data.payment_status, "captured");
  assert.equal((await call("mark_order_paid", { order: "order_1" })).isError, true);
  const created = await call("mark_order_paid", { order: "order_2" });
  assert.equal(created.data.payment_collection_created, true);
  assert.deepEqual(mock.state.newCollection, { order_id: "order_2", amount: 300 });
});

test("create_return defaults to shipped items not yet returned and cleans up on failure", async () => {
  const r = await call("create_return", { order: "order_3", note: "Wrong size" });
  assert.equal(r.isError, false);
  assert.deepEqual(lastRequest((e) => e.p === "/admin/returns/ret_new/request-items").b.items, [{ id: "i4", quantity: 2 }]);
  assert.equal(lastRequest((e) => e.p === "/admin/returns" && e.m === "POST").b.location_id, "sloc_1");

  mock.state.failReturnItems = true;
  const bad = await call("create_return", { order: "order_3" });
  mock.state.failReturnItems = false;
  assert.equal(bad.isError, true);
  assert.ok(lastRequest((e) => e.p === "/admin/returns/ret_new/request" && e.m === "DELETE"));
});

test("receive_return finds the open return and receives the rest", async () => {
  const r = await call("receive_return", { order: "1003" });
  assert.equal(r.data.return_id, "ret_open");
  assert.deepEqual(lastRequest((e) => e.p === "/admin/returns/ret_open/receive-items").b.items, [{ id: "i4", quantity: 1 }]);
  assert.ok(lastRequest((e) => e.p === "/admin/returns/ret_open/receive/confirm"));
});

test("update_order sends only the changed fields", async () => {
  const r = await call("update_order", { order: "1001", email: "new@example.com" });
  assert.deepEqual(lastRequest((e) => e.p === "/admin/orders/order_1" && e.m === "POST").b, { email: "new@example.com" });
  assert.deepEqual(r.data.before, { email: "jan@example.com" });
  assert.deepEqual(r.data.after, { email: "new@example.com" });
  await call("update_order", { order: "1001", email: "jan@example.com" });
});

test("create_product builds a simple product with defaults and initial stock", async () => {
  const r = await call("create_product", {
    title: "New thing",
    prices: [{ currency_code: "CZK", amount: 199 }],
    sku: "NEW-1",
    stock: 7,
    tags: ["sale", "autumn"],
  });
  assert.equal(r.isError, false, r.text);
  const b = mock.state.createdProduct;
  assert.equal(b.status, "draft");
  assert.deepEqual(b.options, [{ title: "Default option", values: ["Default option value"] }]);
  assert.deepEqual(b.variants[0].options, { "Default option": "Default option value" });
  assert.deepEqual(b.variants[0].prices, [{ currency_code: "czk", amount: 199 }]);
  assert.deepEqual(b.sales_channels, [{ id: "sc_1" }]);
  assert.equal(b.shipping_profile_id, "sp_1");
  assert.deepEqual(b.tags, [{ id: "ptag_sale" }, { id: "ptag_autumn" }]);
  assert.deepEqual(r.data.stock, [{ sku: "NEW-1", inventory_item_id: "iitem_new", stocked: 7 }]);
  assert.equal(mock.state.inv.find((i) => i.id === "iitem_new").location_levels[0].stocked_quantity, 7);
});

test("create_product with options validates variant option values", async () => {
  const bad = await call("create_product", {
    title: "Shirt",
    options: [{ title: "Size", values: ["S", "M"] }],
    variants: [{ sku: "SH-S", options: {}, prices: [{ currency_code: "czk", amount: 1 }] }],
  });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /missing a value for option "Size"/);
  const ok = await call("create_product", {
    title: "Shirt",
    options: [{ title: "Size", values: ["S"] }],
    variants: [
      { sku: "SH-S", options: { Size: "S" }, prices: [{ currency_code: "czk", amount: 1 }] },
      { sku: "SH-M", options: { Size: "M" }, prices: [{ currency_code: "czk", amount: 1 }] },
    ],
  });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(mock.state.createdProduct.options, [{ title: "Size", values: ["S", "M"] }]);
  assert.deepEqual(mock.state.createdProduct.variants.map((v) => v.title), ["S", "M"]);
});

test("create_variant adds a new option value first", async () => {
  const r = await call("create_variant", { product_id: "prod_1", options: { Size: "XL" }, sku: "BALL-XL", prices: [{ currency_code: "czk", amount: 450 }] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(mock.state.optionValues, ["S", "M", "XL"]);
  assert.equal(mock.state.createdVariant.title, "XL");
  assert.equal(r.data.variant.id, "variant_xl");
  const unknown = await call("create_variant", { product_id: "prod_1", options: { Size: "S", Color: "Red" }, prices: [{ currency_code: "czk", amount: 1 }] });
  assert.match(unknown.text, /Unknown option\(s\): Color/);
});

test("set_stock_level adds the item to a new location", async () => {
  const r = await call("set_stock_level", { sku: "BALL-1", location_id: "sloc_2", stocked_quantity: 4 });
  assert.equal(r.data.location_added, true);
  assert.deepEqual(lastRequest((e) => e.p === "/admin/inventory-items/iitem_1/location-levels").b, { location_id: "sloc_2", stocked_quantity: 4 });
});

test("create_promotion maps restrictions to target rules and dates to a campaign", async () => {
  const bad = await call("create_promotion", { code: "X", discount_type: "fixed", value: 100 });
  assert.match(bad.text, /currency_code/);
  const r = await call("create_promotion", {
    code: "BALLS20",
    discount_type: "percentage",
    value: 20,
    product_ids: ["prod_1"],
    customer_group_ids: ["cg_b2b"],
    starts_at: "2026-11-01",
    ends_at: "2026-11-30",
  });
  assert.equal(r.isError, false, r.text);
  const b = mock.state.promotion;
  assert.equal(b.application_method.target_type, "items");
  assert.equal(b.application_method.allocation, "across");
  assert.deepEqual(b.application_method.target_rules, [{ attribute: "items.product.id", operator: "in", values: ["prod_1"] }]);
  assert.deepEqual(b.rules, [{ attribute: "customer.groups.id", operator: "in", values: ["cg_b2b"] }]);
  assert.equal(b.campaign.starts_at, "2026-10-31T23:00:00.000Z"); // Prague, CET after DST ends
  assert.equal(b.campaign.ends_at, "2026-11-30T22:59:59.999Z");
  const each = await call("create_promotion", { code: "Y", discount_type: "fixed", value: 50, currency_code: "czk", applies_to: "items", allocation: "each" });
  assert.match(each.text, /max_quantity/);
});

test("save_price_list updates existing prices and creates new ones", async () => {
  const r = await call("save_price_list", {
    price_list_id: "pl_1",
    set_prices: [
      { variant_id: "variant_1", currency_code: "CZK", amount: 280 },
      { variant_id: "variant_1", currency_code: "eur", amount: 12 },
    ],
  });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(mock.state.priceBatch, {
    create: [{ variant_id: "variant_1", currency_code: "eur", amount: 12 }],
    update: [{ id: "plp_1", variant_id: "variant_1", currency_code: "czk", amount: 280 }],
    delete: [],
  });
});

test("medusa_request validates paths and blocks credential endpoints", async () => {
  const ok = await call("medusa_request", { path: "/admin/regions", query: { fields: "id" } });
  assert.equal(ok.data.regions[0].id, "reg_1");
  assert.equal((await call("medusa_request", { path: "/store/products" })).isError, true);
  assert.equal((await call("medusa_request", { path: "/admin/../auth" })).isError, true);
  assert.equal((await call("medusa_request", { path: "/admin/orders?limit=1" })).isError, true);
  const blocked = await call("medusa_request", { method: "POST", path: "/admin/api-keys", body: { title: "x", type: "secret" } });
  assert.match(blocked.text, /blocked/);
  assert.ok(!mock.log.some((e) => e.p === "/admin/api-keys"));
});

test("MEDUSA_RAW_API=false removes medusa_request", async () => {
  const c = new Client({ name: "noraw", version: "1" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "stdio"],
      env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, MEDUSA_RAW_API: "false" },
      stderr: "ignore",
    }),
  );
  const { tools } = await c.listTools();
  await c.close();
  assert.equal(tools.length, 54);
  assert.ok(!tools.some((t) => t.name === "medusa_request"));
});

test("delete_variant keeps a reserved inventory item", async () => {
  const r = await call("delete_variant", { product_id: "prod_1", variant_id: "variant_x", confirm: "BALL-X" });
  assert.equal(mock.state.variantDeleted, true);
  assert.deepEqual(r.data.inventory_items, [{ id: "iitem_2", sku: "NET-1", result: "kept – 1 reserved" }]);
});

test("delete_promotion also removes the campaign it created", async () => {
  const r = await call("delete_promotion", { code: "BALLS20" });
  assert.equal(r.isError, false, r.text);
  assert.equal(mock.state.promotionDeleted, true);
  assert.equal(r.data.campaign_deleted, "procamp_1");
});
