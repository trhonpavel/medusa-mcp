import { z } from "zod";
import {
  dateFilter,
  DEFAULT_TZ,
  isoWeekKey,
  localDate,
  RO,
  round2,
  type Extra,
  type ToolContext,
} from "./helpers.js";

const VALID = (o: any) => !["canceled", "draft"].includes(o.status);
const PAID = new Set(["captured", "partially_refunded", "partially_captured", "refunded"]);

// ---------- date helpers (YYYY-MM-DD) ----------

const DAY = 86_400_000;
const ymdToUtc = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const utcToYmd = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => utcToYmd(ymdToUtc(ymd) + n * DAY);
const daysBetween = (from: string, to: string) => Math.round((ymdToUtc(to) - ymdToUtc(from)) / DAY) + 1;
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
const shiftYear = (ymd: string, years: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  // 29 Feb -> 28 Feb in a non-leap year
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
};
export const today = (tz = DEFAULT_TZ) => localDate(new Date().toISOString(), tz);

/** Variant titles that only say "the one and only variant" add noise to product names. */
const DEFAULT_VARIANT = /^(default|default variant|default option value|standard|výchozí)$/i;
const itemName = (product?: string, variant?: string) =>
  [product, variant && !DEFAULT_VARIANT.test(variant.trim()) && variant !== product ? variant : undefined].filter(Boolean).join(" – ");

/** Change of a metric against the comparison period. */
function delta(current: number, previous: number) {
  return {
    previous: round2(previous),
    change: round2(current - previous),
    change_pct: previous ? round2(((current - previous) / Math.abs(previous)) * 100) : null,
  };
}

// ---------- sales aggregation ----------

type Totals = {
  orders: number;
  revenue: number;
  refunded: number;
  items_total: number;
  subtotal: number;
  shipping: number;
  tax: number;
  discounts: number;
  items_sold: number;
  customers: Set<string>;
};
const newTotals = (): Totals => ({
  orders: 0,
  revenue: 0,
  refunded: 0,
  items_total: 0,
  subtotal: 0,
  shipping: 0,
  tax: 0,
  discounts: 0,
  items_sold: 0,
  customers: new Set(),
});

function totalsByCurrency(orders: any[]) {
  const byCur: Record<string, Totals> = {};
  for (const o of orders) {
    const g = (byCur[(o.currency_code ?? "?").toUpperCase()] ??= newTotals());
    g.orders++;
    g.revenue += Number(o.total ?? 0);
    g.refunded += (o.payment_collections ?? []).reduce((s: number, p: any) => s + Number(p.refunded_amount ?? 0), 0);
    g.items_total += Number(o.item_total ?? 0);
    g.subtotal += Number(o.subtotal ?? 0);
    g.shipping += Number(o.shipping_total ?? 0);
    g.tax += Number(o.tax_total ?? 0);
    g.discounts += Number(o.discount_total ?? 0);
    g.items_sold += (o.items ?? []).reduce((s: number, i: any) => s + Number(i.quantity ?? 0), 0);
    g.customers.add(o.customer_id ?? o.email ?? o.id);
  }
  return Object.fromEntries(
    Object.entries(byCur).map(([cur, g]) => [
      cur,
      {
        orders: g.orders,
        revenue: round2(g.revenue),
        refunded: round2(g.refunded),
        net_revenue: round2(g.revenue - g.refunded),
        avg_order_value: g.orders ? round2(g.revenue / g.orders) : 0,
        items_total: round2(g.items_total),
        subtotal: round2(g.subtotal),
        shipping: round2(g.shipping),
        tax: round2(g.tax),
        discounts: round2(g.discounts),
        items_sold: g.items_sold,
        unique_customers: g.customers.size,
      },
    ]),
  );
}

const SALES_FIELDS =
  "id,display_id,status,payment_status,currency_code,total,subtotal,item_total,shipping_total,tax_total,discount_total," +
  "created_at,customer_id,email,sales_channel_id,shipping_address.country_code,payment_collections.refunded_amount," +
  "items.product_id,items.product_title,items.title,items.variant_sku,items.variant_title,items.quantity,items.total," +
  "items.adjustments.code,items.adjustments.amount";

export function registerReportTools(ctx: ToolContext) {
  const { tool, medusa, progress } = ctx;

  async function loadOrders(extra: Extra, created: Record<string, string> | undefined, fields: string, label: string, max = 20000) {
    return medusa.listAll("/admin/orders", "orders", { fields, created_at: created, order: "created_at" }, max, (n, total) =>
      progress(extra, n, total, `${label}: ${n} of ${total} orders`),
    );
  }

  /** Sales report data – shared by the sales_report tool and the sales dashboard view. */
  async function salesReport(
    a: {
      from: string;
      to: string;
      group_by: "day" | "week" | "month" | "none";
      compare: "previous_period" | "previous_year" | "none";
      top_n: number;
      only_paid: boolean;
      include: ("countries" | "discount_codes" | "variants" | "channels")[];
      timezone: string;
    },
    extra: Extra,
  ) {
    const tz = a.timezone;
    const keep = (o: any) => VALID(o) && (!a.only_paid || PAID.has(o.payment_status));
    const res = await loadOrders(extra, dateFilter(a.from, a.to, tz), SALES_FIELDS, "Loading orders");
    const orders = res.items.filter(keep);

    // Comparison period of the same length (or the same dates a year earlier)
    let comparison: { from: string; to: string; label: string } | undefined;
    if (a.compare !== "none") {
      if (!isYmd(a.from) || !isYmd(a.to)) throw new Error("compare needs plain dates (YYYY-MM-DD) in from/to – or set compare: 'none'.");
      comparison =
        a.compare === "previous_year"
          ? { from: shiftYear(a.from, -1), to: shiftYear(a.to, -1), label: "same period last year" }
          : {
              from: addDays(a.from, -daysBetween(a.from, a.to)),
              to: addDays(a.from, -1),
              label: "previous period",
            };
    }
    const previousOrders = comparison
      ? (
          await loadOrders(
            extra,
            dateFilter(comparison.from, comparison.to, tz),
            "id,status,payment_status,currency_code,total,customer_id,email,payment_collections.refunded_amount,items.quantity",
            "Loading comparison period",
          )
        ).items.filter(keep)
      : [];

    const totals = totalsByCurrency(orders);
    const previous = comparison ? totalsByCurrency(previousOrders) : undefined;
    const change = previous
      ? Object.fromEntries(
          [...new Set([...Object.keys(totals), ...Object.keys(previous)])].map((cur) => {
            const t: any = totals[cur] ?? {};
            const p: any = previous[cur] ?? {};
            return [
              cur,
              Object.fromEntries(
                ["revenue", "net_revenue", "orders", "avg_order_value", "items_sold", "unique_customers"].map((k) => [
                  k,
                  delta(Number(t[k] ?? 0), Number(p[k] ?? 0)),
                ]),
              ),
            ];
          }),
        )
      : undefined;

    const series: Record<string, Record<string, { orders: number; revenue: number }>> = {};
    const products: Record<string, { title: string; quantity: number; revenue: Record<string, number> }> = {};
    const variants: Record<string, { sku?: string; title: string; quantity: number; revenue: Record<string, number> }> = {};
    const countries: Record<string, { orders: number; revenue: Record<string, number> }> = {};
    const codes: Record<string, { orders: number; discount: Record<string, number> }> = {};
    const channels: Record<string, { orders: number; revenue: Record<string, number> }> = {};
    const payStatus: Record<string, number> = {};
    const add = (m: Record<string, number>, cur: string, v: number) => (m[cur] = round2((m[cur] ?? 0) + v));

    for (const o of orders) {
      const cur = (o.currency_code ?? "?").toUpperCase();
      const total = Number(o.total ?? 0);
      payStatus[o.payment_status] = (payStatus[o.payment_status] ?? 0) + 1;
      if (a.group_by !== "none") {
        const d = localDate(o.created_at, tz);
        const key = a.group_by === "day" ? d : a.group_by === "week" ? isoWeekKey(d) : d.slice(0, 7);
        const s = ((series[key] ??= {})[cur] ??= { orders: 0, revenue: 0 });
        s.orders++;
        s.revenue = round2(s.revenue + total);
      }
      const country = (o.shipping_address?.country_code ?? "unknown").toUpperCase();
      const c = (countries[country] ??= { orders: 0, revenue: {} });
      c.orders++;
      add(c.revenue, cur, total);
      const ch = (channels[o.sales_channel_id ?? "none"] ??= { orders: 0, revenue: {} });
      ch.orders++;
      add(ch.revenue, cur, total);
      const orderCodes = new Set<string>();
      for (const i of o.items ?? []) {
        const k = i.product_id ?? i.variant_sku ?? i.title;
        const p = (products[k] ??= { title: i.product_title ?? i.title, quantity: 0, revenue: {} });
        p.quantity += Number(i.quantity ?? 0);
        add(p.revenue, cur, Number(i.total ?? 0));
        const vk = i.variant_sku ?? `${k}:${i.variant_title ?? ""}`;
        const v = (variants[vk] ??= {
          sku: i.variant_sku ?? undefined,
          title: itemName(i.product_title ?? i.title, i.variant_title),
          quantity: 0,
          revenue: {},
        });
        v.quantity += Number(i.quantity ?? 0);
        add(v.revenue, cur, Number(i.total ?? 0));
        for (const adj of i.adjustments ?? []) {
          if (!adj.code) continue;
          orderCodes.add(adj.code);
          add((codes[adj.code] ??= { orders: 0, discount: {} }).discount, cur, Number(adj.amount ?? 0));
        }
      }
      for (const code of orderCodes) codes[code].orders++;
    }

    let channelNames: Record<string, string> = {};
    if (a.include.includes("channels")) {
      const list = (await medusa.cachedGet("/admin/sales-channels", { fields: "id,name", limit: 100 })).sales_channels ?? [];
      channelNames = Object.fromEntries(list.map((c: any) => [c.id, c.name]));
    }
    const byQty = <T extends { quantity: number }>(m: Record<string, T>) =>
      Object.entries(m)
        .sort(([, x], [, y]) => y.quantity - x.quantity)
        .slice(0, a.top_n);

    return {
      period: { from: a.from, to: a.to, timezone: tz, group_by: a.group_by },
      comparison: comparison ? { ...comparison, orders_considered: previousOrders.length } : undefined,
      orders_considered: orders.length,
      orders_excluded: res.items.length - orders.length,
      data_truncated: res.truncated || undefined,
      totals,
      change,
      payment_status_breakdown: payStatus,
      series:
        a.group_by === "none"
          ? undefined
          : Object.entries(series)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([period, cur]) => ({ period, ...cur })),
      top_products: byQty(products).map(([id, p]) => ({ product_id: id, ...p })),
      top_variants: a.include.includes("variants") ? byQty(variants).map(([, v]) => v) : undefined,
      countries: a.include.includes("countries")
        ? Object.entries(countries)
            .sort(([, x], [, y]) => y.orders - x.orders)
            .map(([country, v]) => ({ country, ...v }))
        : undefined,
      discount_codes: a.include.includes("discount_codes")
        ? Object.entries(codes)
            .sort(([, x], [, y]) => y.orders - x.orders)
            .map(([code, v]) => ({ code, ...v }))
        : undefined,
      channels: a.include.includes("channels")
        ? Object.entries(channels).map(([id, v]) => ({ channel: channelNames[id] ?? id, ...v }))
        : undefined,
      note:
        "revenue = order totals incl. tax and shipping; net_revenue subtracts refunds. items_total = line items incl. tax. " +
        "Canceled and draft orders are excluded.",
    };
  }

  tool(
    "sales_report",
    {
      title: "Sales report",
      description:
        "Sales for a period: orders, revenue and net revenue after refunds, average order value, units, unique customers, " +
        "change against the previous period (or last year), a day/week/month series, top products, countries and discount codes. " +
        "Amounts are per currency; canceled and draft orders are excluded. Clients that support MCP Apps show it as an interactive dashboard.",
      inputSchema: {
        from: z.string().describe("From date, e.g. 2026-09-01"),
        to: z.string().describe("To date (inclusive), e.g. 2026-09-30"),
        group_by: z.enum(["day", "week", "month", "none"]).default("day"),
        compare: z.enum(["previous_period", "previous_year", "none"]).default("previous_period"),
        top_n: z.number().int().min(0).max(50).default(10).describe("How many top products (and variants) to return"),
        only_paid: z.boolean().default(false).describe("Only count paid orders"),
        include: z
          .array(z.enum(["countries", "discount_codes", "variants", "channels"]))
          .default(["countries", "discount_codes"])
          .describe("Extra breakdowns"),
        timezone: z.string().default(DEFAULT_TZ).describe("IANA timezone used for date boundaries and buckets"),
      },
      annotations: RO,
      structured: true,
      _meta: { ui: { resourceUri: "ui://medusa/sales-dashboard.html" }, "ui/resourceUri": "ui://medusa/sales-dashboard.html" },
    },
    async (a, extra) => salesReport(a, extra),
  );

  tool(
    "customer_report",
    {
      title: "Customer report",
      description:
        "Customer analytics for a period: new vs returning customers and their revenue, repeat purchase rate, top customers, " +
        "and lapsed customers (bought repeatedly, but not for lapsed_days) worth winning back.",
      inputSchema: {
        from: z.string().describe("From date, e.g. 2026-09-01"),
        to: z.string().describe("To date (inclusive)"),
        top_n: z.number().int().min(1).max(50).default(10),
        lapsed_days: z.number().int().min(14).max(730).default(90),
        timezone: z.string().default(DEFAULT_TZ),
      },
      annotations: RO,
    },
    async (a, extra) => {
      const all = await loadOrders(
        extra,
        dateFilter(undefined, a.to, a.timezone),
        "id,status,customer_id,email,total,currency_code,created_at,customer.first_name,customer.last_name",
        "Loading order history",
        50000,
      );
      const orders = all.items.filter(VALID);
      const from = new Date(dateFilter(a.from, undefined, a.timezone)!.$gte).getTime();
      const to = new Date(dateFilter(undefined, a.to, a.timezone)!.$lte).getTime();

      type C = {
        name?: string;
        email?: string;
        first: number;
        last: number;
        orders: number;
        revenue: Record<string, number>;
        periodOrders: number;
        periodRevenue: Record<string, number>;
      };
      const customers = new Map<string, C>();
      const revenueByCur: Record<string, number> = {};
      for (const o of orders) {
        const key = o.customer_id ?? o.email ?? o.id;
        const at = new Date(o.created_at).getTime();
        const cur = (o.currency_code ?? "?").toUpperCase();
        const total = Number(o.total ?? 0);
        const c: C = customers.get(key) ?? {
          name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || undefined,
          email: o.email,
          first: at,
          last: at,
          orders: 0,
          revenue: {},
          periodOrders: 0,
          periodRevenue: {},
        };
        c.first = Math.min(c.first, at);
        c.last = Math.max(c.last, at);
        c.orders++;
        c.revenue[cur] = round2((c.revenue[cur] ?? 0) + total);
        if (at >= from) {
          c.periodOrders++;
          c.periodRevenue[cur] = round2((c.periodRevenue[cur] ?? 0) + total);
        }
        revenueByCur[cur] = (revenueByCur[cur] ?? 0) + total;
        customers.set(key, c);
      }
      // Rank customers by the store's main currency
      const main = Object.entries(revenueByCur).sort(([, x], [, y]) => y - x)[0]?.[0] ?? "?";
      const active = [...customers.values()].filter((c) => c.periodOrders > 0);
      const isNew = (c: C) => c.first >= from;
      const sumRev = (list: C[]) => {
        const out: Record<string, number> = {};
        for (const c of list) for (const [cur, v] of Object.entries(c.periodRevenue)) out[cur] = round2((out[cur] ?? 0) + v);
        return out;
      };
      const newOnes = active.filter(isNew);
      const returning = active.filter((c) => !isNew(c));
      const shape = (c: C) => ({
        name: c.name,
        email: c.email,
        orders: c.orders,
        lifetime_revenue: c.revenue,
        first_order: localDate(new Date(c.first).toISOString(), a.timezone),
        last_order: localDate(new Date(c.last).toISOString(), a.timezone),
      });
      const lapsedBefore = to - a.lapsed_days * 86_400_000;
      const lifetime = [...customers.values()];
      return {
        period: { from: a.from, to: a.to, timezone: a.timezone },
        main_currency: main,
        data_truncated: all.truncated || undefined,
        period_stats: {
          customers: active.length,
          new_customers: newOnes.length,
          returning_customers: returning.length,
          revenue_new: sumRev(newOnes),
          revenue_returning: sumRev(returning),
          orders: active.reduce((s, c) => s + c.periodOrders, 0),
          orders_per_customer: active.length ? round2(active.reduce((s, c) => s + c.periodOrders, 0) / active.length) : 0,
          repeat_rate_pct: active.length ? round2((active.filter((c) => c.periodOrders > 1).length / active.length) * 100) : 0,
        },
        lifetime_stats: {
          customers: lifetime.length,
          repeat_customers_pct: lifetime.length
            ? round2((lifetime.filter((c) => c.orders > 1).length / lifetime.length) * 100)
            : 0,
          avg_lifetime_revenue: lifetime.length
            ? round2(lifetime.reduce((s, c) => s + (c.revenue[main] ?? 0), 0) / lifetime.length)
            : 0,
        },
        top_customers: active
          .sort((x, y) => (y.periodRevenue[main] ?? 0) - (x.periodRevenue[main] ?? 0))
          .slice(0, a.top_n)
          .map((c) => ({ ...shape(c), period_orders: c.periodOrders, period_revenue: c.periodRevenue })),
        lapsed_customers: lifetime
          .filter((c) => c.orders > 1 && c.last < lapsedBefore)
          .sort((x, y) => (y.revenue[main] ?? 0) - (x.revenue[main] ?? 0))
          .slice(0, a.top_n)
          .map(shape),
      };
    },
  );

  tool(
    "inventory_forecast",
    {
      title: "Inventory forecast",
      description:
        "Restock planning: for every SKU compares recent sales velocity with available stock – days of cover, status " +
        "(out_of_stock, reorder_now, reorder_soon, ok) and a suggested order quantity to cover lead time plus coverage_days. " +
        "Also lists slow movers (stock without sales). Clients that support MCP Apps show it as an interactive table.",
      inputSchema: {
        days: z.number().int().min(7).max(365).default(30).describe("Length of the sales history window"),
        to: z.string().optional().describe("Last day of the sales window, YYYY-MM-DD (default today)"),
        lead_time_days: z.number().int().min(0).max(180).default(14).describe("Days until a new order arrives"),
        coverage_days: z.number().int().min(1).max(365).default(30).describe("How many days the restock should cover"),
        location_id: z.string().optional().describe("Only this stock location"),
        include_ok: z.boolean().default(false).describe("Also list SKUs that need nothing"),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: RO,
      structured: true,
      _meta: { ui: { resourceUri: "ui://medusa/restock.html" }, "ui/resourceUri": "ui://medusa/restock.html" },
    },
    async (a, extra) => {
      if (a.to && !isYmd(a.to)) throw new Error("to must be a date in the form YYYY-MM-DD.");
      const end = a.to ?? today();
      const start = addDays(end, -(a.days - 1));
      const [orders, inventory] = await Promise.all([
        loadOrders(
          extra,
          dateFilter(start, end),
          "id,status,items.variant_sku,items.quantity,items.product_title,items.variant_title",
          "Loading sales",
        ),
        medusa.listAll("/admin/inventory-items", "inventory_items", { fields: "id,sku,title,*location_levels", order: "sku" }, 10000),
      ]);
      const sold = new Map<string, { units: number; title?: string }>();
      for (const o of orders.items.filter(VALID))
        for (const i of o.items ?? []) {
          if (!i.variant_sku) continue;
          const s = sold.get(i.variant_sku) ?? { units: 0, title: itemName(i.product_title, i.variant_title) };
          s.units += Number(i.quantity ?? 0);
          sold.set(i.variant_sku, s);
        }
      const RANK = { out_of_stock: 0, reorder_now: 1, reorder_soon: 2, ok: 3 } as const;
      type Row = {
        sku?: string;
        title?: string;
        inventory_item_id: string;
        sold: number;
        per_day: number;
        available: number;
        incoming?: number;
        days_of_cover: number;
        status: keyof typeof RANK;
        suggested_order: number;
      };
      const rows: Row[] = [];
      const slow: { sku?: string; title?: string; available: number }[] = [];
      for (const it of inventory.items) {
        const levels = (it.location_levels ?? []).filter((l: any) => !a.location_id || l.location_id === a.location_id);
        if (a.location_id && !levels.length) continue;
        const available = levels.reduce(
          (s: number, l: any) => s + Number(l.available_quantity ?? Number(l.stocked_quantity ?? 0) - Number(l.reserved_quantity ?? 0)),
          0,
        );
        const incoming = levels.reduce((s: number, l: any) => s + Number(l.incoming_quantity ?? 0), 0);
        const s = it.sku ? sold.get(it.sku) : undefined;
        const units = s?.units ?? 0;
        const perDay = units / a.days;
        const title = s?.title || it.title;
        if (!units) {
          if (available > 0) slow.push({ sku: it.sku, title, available });
          continue;
        }
        const cover = (available + incoming) / perDay;
        const status: keyof typeof RANK =
          available <= 0 && incoming <= 0
            ? "out_of_stock"
            : cover <= a.lead_time_days
              ? "reorder_now"
              : cover <= a.lead_time_days + Math.min(14, a.coverage_days)
                ? "reorder_soon"
                : "ok";
        const target = perDay * (a.lead_time_days + a.coverage_days);
        rows.push({
          sku: it.sku,
          title,
          inventory_item_id: it.id,
          sold: units,
          per_day: round2(perDay),
          available,
          incoming: incoming || undefined,
          days_of_cover: Math.floor(cover),
          status,
          suggested_order: status === "ok" ? 0 : Math.max(0, Math.ceil(target - available - incoming)),
        });
      }
      rows.sort((x, y) => RANK[x.status] - RANK[y.status] || x.days_of_cover - y.days_of_cover);
      const count = (st: keyof typeof RANK) => rows.filter((r) => r.status === st).length;
      return {
        window: { from: start, to: end, days: a.days },
        settings: { lead_time_days: a.lead_time_days, coverage_days: a.coverage_days, location_id: a.location_id },
        summary: {
          skus_with_sales: rows.length,
          out_of_stock: count("out_of_stock"),
          reorder_now: count("reorder_now"),
          reorder_soon: count("reorder_soon"),
          ok: count("ok"),
          slow_movers: slow.length,
          units_to_order: rows.reduce((s, r) => s + r.suggested_order, 0),
        },
        data_truncated: orders.truncated || inventory.truncated || undefined,
        items: rows.filter((r) => a.include_ok || r.status !== "ok").slice(0, a.limit),
        slow_movers: slow.sort((x, y) => y.available - x.available).slice(0, 20),
        note: "Velocity uses gross units sold (returns not subtracted). Variants without inventory tracking are skipped.",
      };
    },
  );
}
