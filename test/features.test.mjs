// Tests for the 0.4 features: reports, bulk tools, order edits, confirmations, audit log,
// toolsets, resources, prompts and the MCP Apps views. Uses its own mock, so state is fresh.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startMockMedusa, MOCK_KEY } from "./mock-medusa.mjs";
import { roundPrice } from "../dist/tools/bulk.js";
import { fetchImage, isPrivateAddress } from "../dist/tools/fetch-image.js";

let mock, client;

async function connect(env = {}, capabilities = {}) {
  const c = new Client({ name: "test", version: "1" }, { capabilities });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "stdio"],
      env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, REPORT_TIMEZONE: "Europe/Prague", ...env },
      stderr: "ignore",
    }),
  );
  return c;
}

before(async () => {
  mock = await startMockMedusa();
  client = await connect();
});
after(async () => {
  await client?.close();
  mock?.server.close();
});

async function call(name, args = {}, c = client, options) {
  const r = await c.callTool({ name, arguments: args }, undefined, options);
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text), raw: r };
}
const lastRequest = (pred) => [...mock.log].reverse().find(pred);
const requests = (pred) => mock.log.filter(pred);

// ---------- output ----------

test("results drop null fields", async () => {
  const r = await call("get_order", { order: "1001" });
  assert.equal(r.isError, false);
  assert.ok(!r.text.includes("null"), "no null values in the output");
  assert.deepEqual(r.data.discount_codes, { JARO10: 40 });
});

test("GET requests are retried after a 503", async () => {
  mock.state.flaky = 1;
  const before = requests((e) => e.p === "/admin/regions").length;
  const r = await call("medusa_request", { path: "/admin/regions" });
  assert.equal(r.isError, false, r.text);
  assert.equal(requests((e) => e.p === "/admin/regions").length - before, 2);
});

// ---------- reports ----------

test("sales_report compares periods, subtracts refunds and breaks down codes and countries", async () => {
  const progress = [];
  const r = await call("sales_report", { from: "2026-09-01", to: "2026-09-30" }, client, { onprogress: (p) => progress.push(p) });
  assert.equal(r.isError, false, r.text);
  const czk = r.data.totals.CZK;
  assert.equal(czk.revenue, 1210);
  assert.equal(czk.refunded, 200);
  assert.equal(czk.net_revenue, 1010);
  // previous period = 2026-08-02 … 2026-08-31 → order_4 (1000 CZK)
  assert.deepEqual(r.data.comparison, { from: "2026-08-02", to: "2026-08-31", label: "previous period", orders_considered: 1 });
  assert.deepEqual(r.data.change.CZK.revenue, { previous: 1000, change: 210, change_pct: 21 });
  assert.deepEqual(r.data.discount_codes, [{ code: "JARO10", orders: 1, discount: { CZK: 40 } }]);
  assert.deepEqual(r.data.countries, [{ country: "CZ", orders: 1, revenue: { CZK: 1210 } }]);
  assert.ok(r.raw.structuredContent?.totals, "structured content for the dashboard");
  assert.ok(progress.length >= 1, "progress notifications were sent");
});

test("sales_report previous_year shifts the dates by a year", async () => {
  const r = await call("sales_report", { from: "2026-08-01", to: "2026-08-31", compare: "previous_year", group_by: "none" });
  assert.deepEqual(r.data.comparison.from, "2025-08-01");
  assert.equal(r.data.series, undefined);
  const bad = await call("sales_report", { from: "2026-08-01T00:00:00Z", to: "2026-08-31" });
  assert.match(bad.text, /compare needs plain dates/);
});

test("customer_report finds new, returning and lapsed customers", async () => {
  const r = await call("customer_report", { from: "2026-09-01", to: "2026-09-30", lapsed_days: 30 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.period_stats.customers, 1);
  assert.equal(r.data.period_stats.new_customers, 1);
  assert.equal(r.data.period_stats.returning_customers, 0);
  assert.equal(r.data.lifetime_stats.customers, 2);
  assert.equal(r.data.lifetime_stats.repeat_customers_pct, 50);
  assert.deepEqual(r.data.lapsed_customers.map((c) => c.email), ["eva@example.com"]);
  assert.equal(r.data.top_customers[0].email, "jan@example.com");
});

test("inventory_forecast flags out-of-stock SKUs and suggests order quantities", async () => {
  const r = await call("inventory_forecast", { to: "2026-09-30", days: 30, lead_time_days: 14, coverage_days: 30 });
  assert.equal(r.isError, false, r.text);
  const net = r.data.items.find((i) => i.sku === "NET-1");
  assert.equal(net.status, "out_of_stock");
  assert.equal(net.sold, 1);
  assert.equal(net.suggested_order, 2); // ceil(1/30 × 44)
  assert.ok(!r.data.items.some((i) => i.sku === "BALL-1"), "BALL-1 has plenty of cover");
  assert.equal(r.data.summary.ok, 1);
  assert.ok(r.data.slow_movers.some((s) => s.sku === "DEL-1"));
});

// ---------- bulk ----------

test("roundPrice price endings", () => {
  assert.equal(roundPrice(203, "end_9"), 199);
  assert.equal(roundPrice(206, "end_9"), 209);
  assert.equal(roundPrice(5.4, "end_9"), 5);
  assert.equal(roundPrice(19.6, "end_99"), 19.99);
  assert.equal(roundPrice(19.2, "end_99"), 18.99);
  assert.equal(roundPrice(19.3, "end_90"), 18.9);
  assert.equal(roundPrice(12.345, "none"), 12.35);
  assert.equal(roundPrice(-3, "integer"), 0);
});

test("bulk_update_prices previews, then changes only base prices", async () => {
  const none = await call("bulk_update_prices", { currency_code: "czk", percent: 10 });
  assert.match(none.text, /Select products/);

  const preview = await call("bulk_update_prices", { product_ids: ["prod_1"], currency_code: "czk", percent: 10, rounding: "end_9" });
  assert.equal(preview.data.dry_run, true);
  assert.deepEqual(preview.data.preview, [{ product: "Roundnet ball", sku: "BALL-1", variant: "Default", old: 400, new: 439 }]);
  assert.equal(mock.state.variantBatch, undefined, "dry run sends nothing");

  const r = await call("bulk_update_prices", { product_ids: ["prod_1"], currency_code: "czk", percent: 10, rounding: "end_9", dry_run: false });
  assert.equal(r.data.ok, true, r.text);
  const prices = mock.state.variant.prices;
  assert.equal(prices.find((p) => p.id === "price_czk").amount, 439);
  assert.equal(prices.find((p) => p.id === "price_czk_b2b").amount, 350);
  assert.equal(prices.find((p) => p.id === "price_eur").amount, 17);
});

test("bulk_set_stock reports bad rows and applies in one batch", async () => {
  const items = [
    { sku: "BALL-1", adjust_by: 3 },
    { sku: "NET-1", stocked_quantity: 5 },
    { sku: "NOPE", stocked_quantity: 1 },
  ];
  const preview = await call("bulk_set_stock", { items });
  assert.equal(preview.data.changes, 2);
  assert.match(preview.data.errors[0], /NOPE: no inventory item/);
  const refused = await call("bulk_set_stock", { items, dry_run: false });
  assert.match(refused.text, /Nothing was changed/);
  assert.equal(mock.state.levelsBatch, undefined);

  const ok = await call("bulk_set_stock", { items: items.slice(0, 2), dry_run: false });
  assert.equal(ok.data.ok, true, ok.text);
  assert.deepEqual(mock.state.levelsBatch.update, [
    { inventory_item_id: "iitem_1", location_id: "sloc_1", stocked_quantity: 13 },
    { inventory_item_id: "iitem_2", location_id: "sloc_1", stocked_quantity: 5 },
  ]);
});

test("bulk_update_products batches status and tag changes", async () => {
  const preview = await call("bulk_update_products", { product_ids: ["prod_1"], set_status: "draft", add_tags: ["sale"] });
  assert.equal(preview.data.changed, 1);
  assert.match(preview.data.preview[0].changes, /status published → draft/);
  const r = await call("bulk_update_products", { product_ids: ["prod_1"], set_status: "draft", add_tags: ["sale"], add_sales_channel_ids: ["sc_2"], dry_run: false });
  assert.equal(r.data.ok, true, r.text);
  assert.deepEqual(mock.state.productsBatch.update, [{ id: "prod_1", status: "draft", tags: [{ id: "ptag_sale" }] }]);
  assert.deepEqual(mock.state.channelLinks, { channel: "sc_2", add: ["prod_1"] });
});

// ---------- order edits ----------

test("edit_order previews and cancels the edit, then applies it", async () => {
  const preview = await call("edit_order", { order: "1001", add_items: [{ sku: "BALL-1", quantity: 1 }] });
  assert.equal(preview.isError, false, preview.text);
  assert.equal(preview.data.dry_run, true);
  // mock preview: items 2×400 + 410 + new 400, plus 99 shipping = 1709; the order total was 1210
  assert.equal(preview.data.total_after, 1709);
  assert.equal(preview.data.difference, 499);
  assert.equal(mock.state.editCanceled, true);
  assert.deepEqual(lastRequest((e) => e.p === "/admin/order-edits/order_1/items").b, { items: [{ variant_id: "variant_1", quantity: 1 }] });

  const r = await call("edit_order", { order: "1001", change_items: [{ line_item_id: "item_2", quantity: 0 }], dry_run: false });
  assert.equal(r.isError, false, r.text);
  assert.equal(mock.state.editRequested, true);
  assert.equal(mock.state.editConfirmed, true);
  assert.ok(!r.data.items_after.some((i) => i.line_item_id === "item_2"));

  const unknown = await call("edit_order", { order: "1001", change_items: [{ line_item_id: "nope", quantity: 1 }] });
  assert.match(unknown.text, /not on order #1001/);
});

// ---------- images ----------

test("image downloads refuse private addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2a00:1450:4001::1"]) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(fetchImage("http://127.0.0.1:9/x.png"), /private or local/);
  await assert.rejects(fetchImage("http://localhost/x.png"), /private or local/);
  await assert.rejects(fetchImage("file:///etc/passwd"), /Only http/);
});

test("add_product_images can link images without copying them", async () => {
  const r = await call("add_product_images", { product_id: "prod_1", urls: ["https://cdn.example.com/a.jpg"], store_copy: false });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(mock.state.productUpdate, { images: [{ url: "https://cdn.example.com/a.jpg" }], thumbnail: "https://cdn.example.com/a.jpg" });
});

// ---------- confirmations, audit, toolsets ----------

test("destructive tools ask through elicitation and respect a decline", async () => {
  let answer = "decline";
  const asked = [];
  const c = await connect({}, { elicitation: { form: {} } });
  c.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req.params.message);
    return { action: answer };
  });
  const declined = await call("cancel_order", { order: "1003" }, c);
  assert.equal(declined.data.canceled, true);
  assert.match(asked[0], /Cancel order #1003/);
  assert.ok(!lastRequest((e) => e.p === "/admin/orders/order_3/cancel"), "nothing was canceled");

  answer = "accept";
  const accepted = await call("cancel_order", { order: "1003" }, c);
  assert.equal(accepted.data.ok, true, accepted.text);
  assert.ok(lastRequest((e) => e.p === "/admin/orders/order_3/cancel"));
  await c.close();
});

test("write calls are written to the audit log", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "medusa-mcp-")), "audit.jsonl");
  const c = await connect({ AUDIT_LOG: file });
  await call("update_order", { order: "1001", metadata: { note: "audit" } }, c);
  await call("bulk_update_prices", { product_ids: ["prod_1"], currency_code: "czk", percent: 1 }, c); // dry run: not a write
  await call("get_order", { order: "1001" }, c);
  await c.close();
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tool, "update_order");
  assert.equal(lines[0].client, "stdio");
  assert.equal(lines[0].ok, true);
  assert.match(lines[0].args, /audit/);
});

test("MEDUSA_TOOLSETS limits the registered tools", async () => {
  const c = await connect({ MEDUSA_TOOLSETS: "orders,reports" });
  const names = (await c.listTools()).tools.map((t) => t.name);
  await c.close();
  assert.ok(names.includes("get_store_info") && names.includes("get_order") && names.includes("sales_report"));
  assert.ok(!names.includes("list_products") && !names.includes("medusa_request") && !names.includes("bulk_set_stock"));

  const { spawnSync } = await import("node:child_process");
  const bad = spawnSync(process.execPath, ["dist/index.js", "stdio"], {
    env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, MEDUSA_TOOLSETS: "orders,shipping" },
    input: "",
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown MEDUSA_TOOLSETS: shipping/);
});

// ---------- resources, prompts, apps ----------

test("resources expose the store, orders, products and customers with completions", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  for (const u of ["medusa://store", "medusa://orders/1001", "ui://medusa/sales-dashboard.html", "ui://medusa/restock.html"])
    assert.ok(uris.includes(u), u);
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate).sort(), [
    "medusa://customers/{customer}",
    "medusa://orders/{order}",
    "medusa://products/{product}",
  ]);
  const order = await client.readResource({ uri: "medusa://orders/1001" });
  assert.equal(JSON.parse(order.contents[0].text).id, "order_1");
  const product = await client.readResource({ uri: "medusa://products/ball" });
  assert.equal(JSON.parse(product.contents[0].text).id, "prod_1");
  const customer = await client.readResource({ uri: "medusa://customers/jan%40example.com" });
  assert.equal(JSON.parse(customer.contents[0].text).customer.id, "cus_1");
  const done = await client.complete({ ref: { type: "ref/resource", uri: "medusa://orders/{order}" }, argument: { name: "order", value: "100" } });
  assert.ok(done.completion.values.includes("1001"));
});

test("prompts are listed and filled in", async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), [
    "customer_overview",
    "fulfill_orders",
    "handle_return",
    "monthly_report",
    "plan_promotion",
    "restock_plan",
    "store_briefing",
  ]);
  const p = await client.getPrompt({ name: "handle_return", arguments: { order: "1001" } });
  assert.match(p.messages[0].content.text, /order 1001/);
  const m = await client.getPrompt({ name: "monthly_report", arguments: { month: "2026-02" } });
  assert.match(m.messages[0].content.text, /2026-02-01 – 2026-02-28/);
  const months = await client.complete({ ref: { type: "ref/prompt", name: "monthly_report" }, argument: { name: "month", value: "20" } });
  assert.equal(months.completion.values.length, 13);
});

test("report tools link to self-contained MCP Apps views", async () => {
  const { tools } = await client.listTools();
  const sales = tools.find((t) => t.name === "sales_report");
  assert.equal(sales._meta.ui.resourceUri, "ui://medusa/sales-dashboard.html");
  assert.equal(tools.find((t) => t.name === "inventory_forecast")._meta.ui.resourceUri, "ui://medusa/restock.html");
  for (const uri of ["ui://medusa/sales-dashboard.html", "ui://medusa/restock.html"]) {
    const r = await client.readResource({ uri });
    const view = r.contents[0];
    assert.equal(view.mimeType, "text/html;profile=mcp-app");
    assert.ok(view.text.includes("const McpApps={"), "runtime inlined");
    assert.ok(!view.text.includes("__MCP_APPS_RUNTIME__"), "marker replaced");
    assert.ok(!/<script[^>]+src=/.test(view.text), "no external scripts");
  }
});
