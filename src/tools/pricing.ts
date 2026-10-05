import { z } from "zod";
import {
  defined,
  DESTRUCTIVE,
  limitSchema,
  offsetSchema,
  optionalBoundary,
  RO,
  UPDATE,
  type ToolContext,
} from "./helpers.js";

const GROUP_RULE = "customer.groups.id";

function shapePriceList(pl: any, prices?: any[]) {
  return {
    id: pl.id,
    title: pl.title,
    description: pl.description || undefined,
    type: pl.type,
    status: pl.status,
    starts_at: pl.starts_at ?? undefined,
    ends_at: pl.ends_at ?? undefined,
    customer_group_ids: pl.rules?.[GROUP_RULE],
    other_rules: pl.rules
      ? Object.fromEntries(Object.entries(pl.rules).filter(([k]) => k !== GROUP_RULE))
      : undefined,
    prices: prices?.map((p) => ({
      id: p.id,
      variant_id: p.variant_id,
      currency: p.currency_code,
      amount: p.amount,
      min_quantity: p.min_quantity ?? undefined,
    })),
  };
}

export function registerPricingTools(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm, variantIdBySku } = ctx;

  async function loadPrices(id: string): Promise<any[]> {
    const prices = (await medusa.listAll(`/admin/price-lists/${id}/prices`, "prices", {}, 5000)).items;
    // The prices endpoint nests the variant under price_set
    return prices.map((p: any) => ({ ...p, variant_id: p.variant_id ?? p.price_set?.variant?.id }));
  }

  tool(
    "list_price_lists",
    {
      title: "List price lists",
      description:
        "Price lists – sales (temporary discounted prices) and overrides (e.g. B2B prices for a customer group). " +
        "With price_list_id returns that list including all its prices.",
      inputSchema: {
        price_list_id: z.string().optional(),
        q: z.string().optional(),
        status: z.array(z.enum(["active", "draft"])).optional(),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    async (a) => {
      if (a.price_list_id) {
        const [pl, prices] = await Promise.all([
          medusa.get(`/admin/price-lists/${a.price_list_id}`).then((r) => r.price_list),
          loadPrices(a.price_list_id),
        ]);
        return shapePriceList(pl, prices);
      }
      const res = await medusa.get("/admin/price-lists", {
        q: a.q,
        status: a.status,
        order: "-created_at",
        limit: a.limit,
        offset: a.offset,
      });
      return { count: res.count, offset: res.offset, price_lists: (res.price_lists ?? []).map((pl: any) => shapePriceList(pl)) };
    },
  );

  if (cfg.readOnly) return;

  tool(
    "save_price_list",
    {
      title: "Create or update price list",
      description:
        "Without price_list_id creates a price list (title required); with price_list_id updates it. " +
        "'set_prices' adds or changes the price of a variant in a currency; 'remove_variants' drops variants from the list. " +
        "type 'sale' shows the original price struck through, 'override' simply replaces it. Plain dates use the reporting timezone.",
      inputSchema: {
        price_list_id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        type: z.enum(["sale", "override"]).optional().describe("Default for new lists: sale"),
        status: z.enum(["active", "draft"]).optional().describe("Default for new lists: active"),
        starts_at: z.string().nullable().optional().describe("E.g. 2026-11-27; null removes"),
        ends_at: z.string().nullable().optional().describe("Inclusive, e.g. 2026-11-30; null removes"),
        customer_group_ids: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("Only for these customer groups; [] or null = everyone"),
        set_prices: z
          .array(
            z.object({
              variant_id: z.string().optional(),
              sku: z.string().optional(),
              currency_code: z.string().length(3),
              amount: z.number().nonnegative().describe("Major units"),
            }),
          )
          .optional(),
        remove_variants: z.array(z.string()).optional().describe("Variant IDs whose prices are removed from the list"),
      },
      annotations: UPDATE,
    },
    async (a) => {
      const wanted = [];
      for (const p of a.set_prices ?? []) {
        const variant_id = p.variant_id ?? (p.sku ? await variantIdBySku(p.sku) : undefined);
        if (!variant_id) throw new Error("Each price needs variant_id or sku.");
        wanted.push({ variant_id, currency_code: p.currency_code.toLowerCase(), amount: p.amount });
      }
      const header = defined({
        title: a.title,
        description: a.description,
        type: a.type,
        status: a.status,
        starts_at: optionalBoundary(a.starts_at, false),
        ends_at: optionalBoundary(a.ends_at, true),
        rules: a.customer_group_ids === undefined ? undefined : { [GROUP_RULE]: a.customer_group_ids ?? [] },
      });

      let id = a.price_list_id;
      let created = false;
      if (!id) {
        if (!a.title) throw new Error("title is required to create a price list.");
        const pl = (
          await medusa.post("/admin/price-lists", {
            description: "",
            type: "sale",
            status: "active",
            ...header,
            prices: wanted,
          })
        ).price_list;
        id = pl.id as string;
        created = true;
      } else {
        if (Object.keys(header).length) await medusa.post(`/admin/price-lists/${id}`, header);
        if (wanted.length || a.remove_variants?.length) {
          const existing = await loadPrices(id);
          const base = existing.filter((p) => !p.min_quantity);
          const create: any[] = [];
          const update: any[] = [];
          for (const w of wanted) {
            const hit = base.find((p) => p.variant_id === w.variant_id && p.currency_code === w.currency_code);
            if (hit) update.push({ id: hit.id, ...w });
            else create.push(w);
          }
          const remove = existing.filter((p) => a.remove_variants?.includes(p.variant_id)).map((p) => p.id);
          await medusa.post(`/admin/price-lists/${id}/prices/batch`, { create, update, delete: remove });
        } else if (!Object.keys(header).length) throw new Error("Nothing to update.");
      }
      const [pl, prices] = await Promise.all([
        medusa.get(`/admin/price-lists/${id}`).then((r) => r.price_list),
        loadPrices(id),
      ]);
      return { ok: true, created, price_list: shapePriceList(pl, prices) };
    },
  );

  tool(
    "delete_price_list",
    {
      title: "Delete price list",
      description: "DELETES a price list – its prices stop applying immediately. Confirm with the user first.",
      inputSchema: { price_list_id: z.string() },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const pl = (await medusa.get(`/admin/price-lists/${a.price_list_id}`)).price_list;
      await confirm(extra, `Delete price list "${pl.title}"? Its prices stop applying immediately.`);
      await medusa.delete(`/admin/price-lists/${a.price_list_id}`);
      return { ok: true, deleted: a.price_list_id };
    },
  );
}
