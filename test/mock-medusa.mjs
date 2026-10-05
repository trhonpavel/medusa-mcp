// Minimal mock of the Medusa v2 Admin API used by the test suite.
import http from "node:http";

export const MOCK_KEY = "sk_test_123";

export function startMockMedusa(port = 0) {

const KEY = MOCK_KEY;
const log = [];
const state = {
  orders: [
    {
      id: "order_1", display_id: 1001, status: "pending", payment_status: "captured", fulfillment_status: "not_fulfilled",
      email: "jan@example.com", currency_code: "czk", total: 1210, item_total: 1111, subtotal: 1000, shipping_total: 99, tax_total: 210, discount_total: 0,
      created_at: "2026-09-10T08:00:00Z", customer_id: "cus_1", customer: { first_name: "Jan", last_name: "Novák" },
      shipping_address: { city: "Prague", country_code: "cz", province: null },
      items: [{ id: "item_1", quantity: 2, title: "Ball", product_title: "Roundnet ball", product_id: "prod_1", variant_id: "variant_1", variant_sku: "BALL-1", total: 800, unit_price: 400, detail: { fulfilled_quantity: 0, shipped_quantity: 0 }, adjustments: [{ code: "JARO10", amount: 40 }] },
              { id: "item_2", quantity: 1, title: "Net", product_title: "Net", product_id: "prod_2", variant_sku: "NET-1", total: 410, unit_price: 410, detail: { fulfilled_quantity: 0 } }],
      fulfillments: [],
      payment_collections: [{ id: "paycol_1", status: "completed", amount: 1210, refunded_amount: 200, payments: [
        { id: "pay_1", amount: 1210, currency_code: "czk", provider_id: "pp_stripe", captures: [{ amount: 1210 }], refunds: [{ amount: 200 }] },
      ] }],
    },
    {
      id: "order_2", display_id: 1002, status: "canceled", payment_status: "refunded", fulfillment_status: "not_fulfilled",
      email: "x@example.com", currency_code: "czk", total: -500, summary: { pending_difference: 300 }, created_at: "2026-09-11T22:30:00Z", customer_id: "cus_2",
      items: [{ id: "i3", quantity: 1, product_id: "prod_1", total: 500 }],
    },
    {
      id: "order_3", display_id: 1003, status: "completed", payment_status: "captured", fulfillment_status: "shipped",
      email: "jan@example.com", currency_code: "eur", total: 50, created_at: "2026-09-30T22:30:00Z", customer_id: "cus_1",
      items: [{ id: "i4", quantity: 3, product_id: "prod_1", product_title: "Roundnet ball", total: 50, detail: { shipped_quantity: 3, return_requested_quantity: 1 } }],
      payment_collections: [{ id: "paycol_3", status: "not_paid", amount: 50, payments: [] }],
    },
    {
      id: "order_4", display_id: 1004, status: "completed", payment_status: "captured", fulfillment_status: "shipped",
      email: "eva@example.com", currency_code: "czk", total: 1000, created_at: "2026-08-15T10:00:00Z", customer_id: "cus_3",
      customer: { first_name: "Eva", last_name: "Malá" }, shipping_address: { country_code: "sk" },
      items: [{ id: "i5", quantity: 1, product_id: "prod_1", product_title: "Roundnet ball", variant_sku: "BALL-1", total: 1000 }],
    },
    {
      id: "order_5", display_id: 1005, status: "completed", payment_status: "captured", fulfillment_status: "shipped",
      email: "eva@example.com", currency_code: "czk", total: 500, created_at: "2026-06-01T10:00:00Z", customer_id: "cus_3",
      customer: { first_name: "Eva", last_name: "Malá" }, items: [{ id: "i6", quantity: 1, product_id: "prod_1", variant_sku: "BALL-1", total: 500 }],
    },
  ],
  variant: { id: "variant_1", title: "Default", sku: "BALL-1", prices: [
    { id: "price_czk", currency_code: "czk", amount: 400, rules: {} },
    { id: "price_eur", currency_code: "eur", amount: 17, rules: {} },
    { id: "price_czk_b2b", currency_code: "czk", amount: 350, rules: { customer_group_id: "cg_b2b" } },
  ]},
  inv: [
    { id: "iitem_1", sku: "BALL-1", title: "Ball", location_levels: [{ location_id: "sloc_1", stocked_quantity: 10, reserved_quantity: 2, available_quantity: 8 }] },
    { id: "iitem_2", sku: "NET-1", title: "Net", reserved_quantity: 1, location_levels: [{ location_id: "sloc_1", stocked_quantity: 1, reserved_quantity: 1, available_quantity: 0 }] },
    { id: "iitem_new", sku: "NEW-1", title: "New", location_levels: [] },
    { id: "iitem_del", sku: "DEL-1", title: "Test product", reserved_quantity: 0, location_levels: [{ location_id: "sloc_1", stocked_quantity: 5, reserved_quantity: 0, available_quantity: 5 }] },
  ],
  returns: [{ id: "ret_open", order_id: "order_3", status: "requested", items: [{ item_id: "i4", quantity: 1, received_quantity: 0 }] }],
  tags: [{ id: "ptag_sale", value: "sale" }],
  products: [],
  flaky: 0,
  priceListPrices: [{ id: "plp_1", price_set: { id: "pset_1", variant: { id: "variant_1" } }, currency_code: "czk", amount: 300 }],
};

// prod_1 always shows the current variant (prices change during the tests)
state.products.push({
  id: "prod_1", title: "Roundnet ball", handle: "ball", status: "published", collection_id: null, discountable: true,
  categories: [], tags: [], sales_channels: [{ id: "sc_1", name: "Web" }],
  get variants() { return [state.variant]; },
});

function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

// Mirrors Medusa's prepareListQuery: one plain field (no +, -, * prefix and no .* suffix) replaces the
// default fields entirely, so only id, the listed fields and the listed relations come back.
function selectFields(obj, fields) {
  if (!obj || fields == null) return obj;
  const list = fields.split(",").filter(Boolean);
  const replaces = !list.length || list.some((f) => !/^[+\- *]/.test(f) && !f.endsWith(".*"));
  if (!replaces) return obj;
  const keep = new Set(["id", ...list.map((f) => f.replace(/^[+ *-]/, "").replace(/\.\*$/, "").split(".")[0])]);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let body = ""; for await (const c of req) body += c;
  log.push({ m: req.method, p: u.pathname, q: decodeURIComponent(u.search), b: body ? JSON.parse(body) : undefined });
  if (u.pathname === "/__log") return send(res, 200, log);
  const expected = "Basic " + Buffer.from(KEY + ":").toString("base64");
  if (req.headers.authorization !== expected) return send(res, 401, { message: "Unauthorized" });
  const p = u.pathname;
  if (p === "/admin/orders" && req.method === "GET") {
    let o = state.orders;
    const gte = u.searchParams.get("created_at[$gte]"), lte = u.searchParams.get("created_at[$lte]");
    if (gte) o = o.filter(x => x.created_at >= gte);
    if (lte) o = o.filter(x => x.created_at <= lte);
    const q = u.searchParams.get("q"); if (q) o = o.filter(x => String(x.display_id).includes(q) || x.email.includes(q));
    const cid = u.searchParams.get("customer_id"); if (cid) o = o.filter(x => x.customer_id === cid);
    const off = +(u.searchParams.get("offset") ?? 0), lim = +(u.searchParams.get("limit") ?? 50);
    const f = u.searchParams.get("fields");
    return send(res, 200, { orders: o.slice(off, off + lim).map((x) => selectFields(x, f)), count: o.length, offset: off, limit: lim });
  }
  let m;
  if ((m = p.match(/^\/admin\/orders\/([^/]+)$/)) && req.method === "GET")
    return send(res, 200, { order: selectFields(state.orders.find(o => o.id === m[1]), u.searchParams.get("fields")) });
  if ((m = p.match(/^\/admin\/orders\/([^/]+)\/fulfillments$/))) {
    const o = state.orders.find(o => o.id === m[1]);
    o.fulfillments.push({ id: "ful_1", shipped_at: null, items: JSON.parse(body).items.map(i => ({ line_item_id: i.id, quantity: i.quantity })) });
    o.fulfillment_status = "fulfilled"; return send(res, 200, { order: o });
  }
  if ((m = p.match(/^\/admin\/orders\/([^/]+)\/fulfillments\/([^/]+)\/shipments$/))) {
    const o = state.orders.find(o => o.id === m[1]); o.fulfillment_status = "shipped"; return send(res, 200, { order: o });
  }
  if ((m = p.match(/^\/admin\/orders\/([^/]+)\/cancel$/))) return send(res, 200, { order: { status: "canceled" } });
  if (p === "/admin/customers") return send(res, 200, { customers: [{ id: "cus_1", email: "jan@example.com", first_name: "Jan", last_name: "Novák", has_account: true }], count: 1, offset: 0 });
  if (p === "/admin/customers/cus_1") return send(res, 200, { customer: { id: "cus_1", email: "jan@example.com", addresses: [], groups: [] } });
  if (p === "/admin/products" && req.method === "GET") {
    let list = state.products;
    const ids = u.searchParams.getAll("id[]"); if (ids.length) list = list.filter((x) => ids.includes(x.id));
    const handle = u.searchParams.get("handle"); if (handle) list = list.filter((x) => x.handle === handle);
    return send(res, 200, { products: JSON.parse(JSON.stringify(list)), count: list.length, offset: 0 });
  }
  if (p === "/admin/products/prod_1" && req.method === "POST") {
    state.productUpdate = JSON.parse(body);
    return send(res, 200, { product: { id: "prod_1", ...state.productUpdate } });
  }
  if (p === "/admin/products/prod_1") return send(res, 200, { product: { id: "prod_1", title: "Roundnet ball", status: "published", options: [{ id: "opt_size", title: "Size", values: [{ value: "S" }, { value: "M" }] }], variants: [{ ...state.variant, inventory_items: [{ inventory_item_id: "iitem_1" }] }] } });
  if (p === "/admin/products/prod_del") {
    if (req.method === "DELETE") { state.productDeleted = true; return send(res, 200, { id: "prod_del", object: "product", deleted: true }); }
    if (state.productDeleted) return send(res, 404, { message: "Product with id: prod_del was not found" });
    return send(res, 200, { product: { id: "prod_del", title: "Test product", handle: "test-product", status: "draft",
      variants: [{ id: "variant_del", sku: "DEL-1", inventory_items: [{ inventory_item_id: "iitem_del" }] }] } });
  }
  if ((m = p.match(/^\/admin\/inventory-items\/([^/]+)$/))) {
    const i = state.inv.findIndex(x => x.id === m[1]);
    if (i < 0) return send(res, 404, { message: "Inventory item not found" });
    if (req.method === "DELETE") { state.inv.splice(i, 1); return send(res, 200, { id: m[1], deleted: true }); }
    return send(res, 200, { inventory_item: state.inv[i] });
  }
  if (p === "/admin/stock-locations") return send(res, 200, { stock_locations: [{ id: "sloc_1", name: "Main warehouse", address: { city: "Main warehouse", country_code: "cz" } }], count: 1 });
  if (p === "/admin/regions" && state.flaky > 0) { state.flaky--; return send(res, 503, { message: "Service unavailable" }); }
  if (p === "/admin/regions") return send(res, 200, { regions: [{ id: "reg_1", name: "Czechia", currency_code: "czk", countries: [{ iso_2: "cz" }] }] });
  if (p === "/admin/sales-channels") return send(res, 200, { sales_channels: [{ id: "sc_1", name: "Web" }] });
  if (p === "/admin/products/prod_1/variants/variant_x") {
    if (req.method === "DELETE") { state.variantDeleted = true; return send(res, 200, { deleted: true }); }
    return send(res, 200, { variant: { id: "variant_x", title: "X", sku: "BALL-X", inventory_items: [{ inventory_item_id: "iitem_2" }] } });
  }
  if (p === "/admin/products/prod_1/variants/variant_1") {
    if (req.method === "POST") { state.variant.prices = JSON.parse(body).prices; return send(res, 200, { product: {} }); }
    return send(res, 200, { variant: state.variant });
  }
  if (p === "/admin/inventory-items") {
    let it = state.inv; const sku = u.searchParams.get("sku"); if (sku) it = it.filter(i => i.sku === sku);
    const skus = u.searchParams.getAll("sku[]"); if (skus.length) it = it.filter(i => skus.includes(i.sku));
    const ids = u.searchParams.getAll("id[]"); if (ids.length) it = it.filter(i => ids.includes(i.id));
    const off = +(u.searchParams.get("offset") ?? 0), lim = +(u.searchParams.get("limit") ?? 50);
    return send(res, 200, { inventory_items: it.slice(off, off + lim), count: it.length, offset: off });
  }
  if ((m = p.match(/^\/admin\/inventory-items\/([^/]+)\/location-levels\/([^/]+)$/))) {
    const it = state.inv.find(i => i.id === m[1]); it.location_levels[0].stocked_quantity = JSON.parse(body).stocked_quantity;
    return send(res, 200, { inventory_item: it });
  }
  const b = body ? JSON.parse(body) : {};
  if ((m = p.match(/^\/admin\/orders\/([^/]+)$/)) && req.method === "POST") {
    const o = state.orders.find(o => o.id === m[1]); Object.assign(o, b); return send(res, 200, { order: o });
  }
  if (p === "/admin/payment-collections" && req.method === "POST") { state.newCollection = b; return send(res, 200, { payment_collection: { id: "paycol_new", amount: b.amount } }); }
  if ((m = p.match(/^\/admin\/payment-collections\/([^/]+)\/mark-as-paid$/))) {
    const o = state.orders.find(o => o.id === b.order_id); o.payment_status = "captured"; return send(res, 200, { payment_collection: { id: m[1] } });
  }
  if ((m = p.match(/^\/admin\/payments\/([^/]+)\/refund$/))) {
    state.orders[0].payment_collections[0].payments[0].refunds.push({ amount: b.amount }); return send(res, 200, { payment: { id: m[1] } });
  }
  if (p === "/admin/returns" && req.method === "POST") return send(res, 200, { return: { id: "ret_new", order_id: b.order_id } });
  if (p === "/admin/returns") return send(res, 200, { returns: state.returns.filter(r => r.order_id === u.searchParams.get("order_id")), count: 1 });
  if (p === "/admin/returns/ret_new/request-items") {
    if (state.failReturnItems) return send(res, 400, { message: "Item cannot be returned" });
    return send(res, 200, { return: { id: "ret_new" } });
  }
  if (p === "/admin/returns/ret_new/request") return send(res, 200, { return: { id: "ret_new", status: "requested" } });
  if ((m = p.match(/^\/admin\/returns\/([^/]+)\/(receive|receive-items|receive\/confirm)$/))) return send(res, 200, { return: { id: m[1], status: "received" } });
  if (p === "/admin/stores") return send(res, 200, { stores: [{ id: "store_1", default_sales_channel_id: "sc_1" }] });
  if (p === "/admin/shipping-profiles") return send(res, 200, { shipping_profiles: [{ id: "sp_digital", type: "digital" }, { id: "sp_1", type: "default" }] });
  if (p === "/admin/product-tags" && req.method === "POST") { const t = { id: "ptag_" + b.value, value: b.value }; state.tags.push(t); return send(res, 200, { product_tag: t }); }
  if (p === "/admin/product-tags") { const vals = u.searchParams.getAll("value[]"); return send(res, 200, { product_tags: state.tags.filter(t => vals.includes(t.value)) }); }
  if (p === "/admin/products" && req.method === "POST") {
    state.createdProduct = b;
    return send(res, 200, { product: { id: "prod_new", title: b.title, handle: "new", status: b.status, variants: b.variants.map((v, i) => ({ id: "variant_new" + i, ...v })) } });
  }
  if (p === "/admin/products/prod_new") return send(res, 200, { product: { id: "prod_new", variants: state.createdProduct.variants.map((v) => ({ ...v, inventory_items: v.sku === "NEW-1" ? [{ inventory_item_id: "iitem_new" }] : [] })) } });
  if ((m = p.match(/^\/admin\/inventory-items\/([^/]+)\/location-levels$/))) {
    const it = state.inv.find(i => i.id === m[1]); it.location_levels.push({ location_id: b.location_id, stocked_quantity: b.stocked_quantity, reserved_quantity: 0 });
    return send(res, 200, { inventory_item: it });
  }
  if (p === "/admin/products/prod_1/options/opt_size") { state.optionValues = b.values; return send(res, 200, { product: {} }); }
  if (p === "/admin/products/prod_1/variants" && req.method === "POST") {
    state.createdVariant = b; return send(res, 200, { product: { id: "prod_1", variants: [state.variant, { id: "variant_xl", ...b }] } });
  }
  if (p === "/admin/promotions" && req.method === "POST") { state.promotion = { id: "promo_1", ...b }; return send(res, 200, { promotion: state.promotion }); }
  if (p === "/admin/promotions/promo_1") {
    if (req.method === "DELETE") { state.promotionDeleted = true; return send(res, 200, { id: "promo_1", deleted: true }); }
    return send(res, 200, { promotion: { ...state.promotion, campaign: state.promotion.campaign && { id: "procamp_1", ...state.promotion.campaign } } });
  }
  if (p === "/admin/promotions" && u.searchParams.get("campaign_id")) return send(res, 200, { promotions: [], count: 0 });
  if (p === "/admin/promotions") return send(res, 200, { promotions: state.promotion && !state.promotionDeleted ? [{ ...state.promotion, campaign: { id: "procamp_1", ...state.promotion.campaign } }] : [], count: 1 });
  if (p === "/admin/campaigns/procamp_1" && req.method === "DELETE") { state.campaignDeleted = true; return send(res, 200, { deleted: true }); }
  if (p === "/admin/price-lists/pl_1") return send(res, 200, { price_list: { id: "pl_1", title: "B2B", type: "override", status: "active", rules: {} } });
  if (p === "/admin/price-lists/pl_1/prices") return send(res, 200, { prices: state.priceListPrices, count: state.priceListPrices.length });
  if (p === "/admin/price-lists/pl_1/prices/batch") { state.priceBatch = b; return send(res, 200, {}); }
  if (p === "/admin/product-variants") {
    const all = [{ id: "variant_1", sku: "BALL-1", product_id: "prod_1" }];
    const q = u.searchParams.get("q");
    const list = q ? all.filter((v) => v.sku.includes(q)) : all;
    return send(res, 200, { variants: list, count: list.length, offset: 0 });
  }
  if (p === "/admin/products/prod_1/variants/batch") {
    state.variantBatch = b;
    for (const up of b.update ?? []) if (up.id === state.variant.id && up.prices) state.variant.prices = up.prices;
    return send(res, 200, { created: [], updated: b.update ?? [], deleted: [] });
  }
  if (p === "/admin/products/batch") { state.productsBatch = b; return send(res, 200, { created: [], updated: b.update ?? [], deleted: [] }); }
  if ((m = p.match(/^\/admin\/sales-channels\/([^/]+)\/products$/))) { state.channelLinks = { channel: m[1], ...b }; return send(res, 200, { sales_channel: { id: m[1] } }); }
  if (p === "/admin/inventory-items/location-levels/batch") { state.levelsBatch = b; return send(res, 200, { created: b.create ?? [], updated: b.update ?? [], deleted: [] }); }
  if (p === "/admin/order-edits" && req.method === "POST") { state.edit = { order_id: b.order_id, items: null }; return send(res, 200, { order_change: { id: "ordch_1", order_id: b.order_id } }); }
  if ((m = p.match(/^\/admin\/order-edits\/([^/]+)(\/.*)?$/))) {
    const o = state.orders.find((x) => x.id === m[1]);
    const rest = m[2] ?? "";
    state.edit ??= { order_id: m[1], items: null };
    state.edit.items ??= JSON.parse(JSON.stringify(o.items));
    if (req.method === "DELETE" && !rest) { state.editCanceled = true; state.edit = null; return send(res, 200, { id: m[1], deleted: true }); }
    if (rest === "/items") for (const it of b.items) state.edit.items.push({ id: "new_" + it.variant_id, variant_id: it.variant_id, variant_sku: "BALL-1", title: "Ball", quantity: it.quantity, unit_price: it.unit_price ?? 400 });
    let mm;
    if ((mm = rest.match(/^\/items\/item\/(.+)$/))) state.edit.items.find((i) => i.id === mm[1]).quantity = b.quantity;
    if (rest === "/request") state.editRequested = true;
    if (rest === "/confirm") state.editConfirmed = true;
    const total = state.edit.items.reduce((s, i) => s + i.quantity * (i.unit_price ?? 0), 0) + (o.shipping_total ?? 0);
    return send(res, 200, { order_preview: { id: o.id, items: state.edit.items, total } });
  }
  send(res, 404, { message: "not mocked: " + p });
});
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, log, state, url: `http://127.0.0.1:${server.address().port}` })));
}

