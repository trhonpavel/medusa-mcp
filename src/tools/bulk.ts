import { z } from "zod";
import { defined, DESTRUCTIVE, errorMessage, round2, type ToolContext } from "./helpers.js";

const PRODUCT_STATUS = z.enum(["draft", "proposed", "published", "rejected"]);
const MAX_PRODUCTS = 2000;
const PREVIEW_ROWS = 100;

/** Which products a bulk action targets. */
const selectionShape = {
  product_ids: z.array(z.string()).optional(),
  category_id: z.string().optional(),
  collection_id: z.string().optional(),
  tag: z.string().optional().describe("Tag value"),
  status: z.array(PRODUCT_STATUS).optional(),
  q: z.string().optional().describe("Full-text filter"),
  all_products: z.boolean().optional().describe("Must be true to target the whole catalog without other filters"),
};
type Selection = {
  product_ids?: string[];
  category_id?: string;
  collection_id?: string;
  tag?: string;
  status?: z.infer<typeof PRODUCT_STATUS>[];
  q?: string;
  all_products?: boolean;
};

const ROUNDING = z
  .enum(["none", "integer", "end_9", "end_90", "end_99"])
  .default("none")
  .describe("none = 2 decimals; integer; end_9 = nearest whole number ending in 9 (199, 249); end_90 / end_99 = nearest x.90 / x.99");

/** Nearest of the candidates; ties go to the lower price. */
const nearest = (v: number, candidates: number[]) =>
  candidates.filter((c) => c > 0).sort((x, y) => Math.abs(x - v) - Math.abs(y - v) || x - y)[0] ?? round2(v);

export function roundPrice(v: number, mode: z.infer<typeof ROUNDING>): number {
  if (v <= 0) return 0;
  switch (mode) {
    case "integer":
      return Math.max(1, Math.round(v));
    case "end_9": {
      if (v < 9) return Math.max(1, Math.round(v));
      const base = Math.floor(Math.round(v) / 10) * 10;
      return nearest(v, [base - 1, base + 9]);
    }
    case "end_90":
      return round2(nearest(v, [Math.floor(v) - 0.1, Math.floor(v) + 0.9]));
    case "end_99":
      return round2(nearest(v, [Math.floor(v) - 0.01, Math.floor(v) + 0.99]));
    default:
      return round2(v);
  }
}

const isBasePrice = (p: any, cur: string) =>
  p.currency_code === cur &&
  (!p.rules || !Object.keys(p.rules).length) &&
  !p.price_rules?.length &&
  !Number(p.rules_count ?? 0) &&
  !p.min_quantity;

export function registerBulkTools(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm, progress, resolveTagIds } = ctx;
  if (cfg.readOnly) return;

  async function selectProducts(sel: Selection, fields: string, skus?: string[]) {
    let ids = sel.product_ids;
    if (skus?.length) {
      const wanted = new Set(skus);
      const variants = await medusa.listAll("/admin/product-variants", "variants", { fields: "id,sku,product_id" }, 20000);
      const found = variants.items.filter((v: any) => wanted.has(v.sku));
      const missing = skus.filter((s) => !found.some((v: any) => v.sku === s));
      if (missing.length) throw new Error(`Unknown SKU(s): ${missing.join(", ")}`);
      const fromSkus = [...new Set(found.map((v: any) => v.product_id as string))];
      ids = ids ? ids.filter((i) => fromSkus.includes(i)) : fromSkus;
    }
    const filtered = ids || sel.category_id || sel.collection_id || sel.tag || sel.status?.length || sel.q;
    if (!filtered && !sel.all_products)
      throw new Error("Select products (product_ids, skus, category_id, collection_id, tag, status or q), or set all_products: true.");
    let tagId: string | undefined;
    if (sel.tag) {
      const t = (await medusa.get("/admin/product-tags", { value: [sel.tag], fields: "id", limit: 1 })).product_tags?.[0];
      if (!t) throw new Error(`Tag "${sel.tag}" does not exist.`);
      tagId = t.id;
    }
    const res = await medusa.listAll(
      "/admin/products",
      "products",
      {
        fields,
        id: ids,
        category_id: sel.category_id ? [sel.category_id] : undefined,
        collection_id: sel.collection_id ? [sel.collection_id] : undefined,
        tag_id: tagId ? [tagId] : undefined,
        status: sel.status,
        q: sel.q,
        order: "title",
      },
      MAX_PRODUCTS,
    );
    if (res.truncated) throw new Error(`The selection has more than ${MAX_PRODUCTS} products – narrow it down.`);
    if (!res.items.length) throw new Error("No products match the selection.");
    return res.items as any[];
  }

  // ===== Prices =====
  tool(
    "bulk_update_prices",
    {
      title: "Bulk update prices",
      description:
        "Changes the base prices of many variants at once in one currency: by percent (+10 / -15), by an amount, or to a fixed price, " +
        "with optional price-ending rounding. Targets products by IDs, SKUs, category, collection, tag, status or search. " +
        "dry_run (default true) only previews the changes; repeat with dry_run false to apply. " +
        "Prices with rules (customer groups, quantities) are kept. For temporary sales prefer save_price_list or create_promotion.",
      inputSchema: {
        ...selectionShape,
        skus: z.array(z.string()).optional().describe("Only these variants"),
        currency_code: z.string().length(3),
        percent: z.number().min(-90).max(1000).optional().describe("E.g. 10 = +10 %, -15 = -15 %"),
        add_amount: z.number().optional().describe("E.g. 20 or -20 (major units)"),
        set_amount: z.number().positive().optional().describe("Set every selected price to this amount"),
        rounding: ROUNDING,
        dry_run: z.boolean().default(true),
      },
      annotations: DESTRUCTIVE,
      isWrite: (a) => !a.dry_run,
    },
    async (a, extra) => {
      const ops = [a.percent, a.add_amount, a.set_amount].filter((v) => v !== undefined).length;
      if (ops !== 1) throw new Error("Provide exactly one of: percent, add_amount, set_amount.");
      const cur = a.currency_code.toLowerCase();
      const products = await selectProducts(a, "id,title,*variants,*variants.prices", a.skus);
      const skuFilter = a.skus?.length ? new Set(a.skus) : undefined;
      type Change = { product_id: string; product: string; variant_id: string; sku?: string; variant: string; old: number; new: number };
      const changes: Change[] = [];
      const updates = new Map<string, { id: string; prices: any[] }[]>();
      let missing = 0;
      for (const p of products)
        for (const v of p.variants ?? []) {
          if (skuFilter && !skuFilter.has(v.sku)) continue;
          const prices: any[] = v.prices ?? [];
          const base = prices.find((x) => isBasePrice(x, cur));
          if (!base) {
            missing++;
            continue;
          }
          const old = Number(base.amount);
          const raw = a.set_amount ?? (a.percent !== undefined ? old * (1 + a.percent / 100) : old + a.add_amount!);
          const next = roundPrice(raw, a.rounding);
          if (next === old) continue;
          changes.push({ product_id: p.id, product: p.title, variant_id: v.id, sku: v.sku, variant: v.title, old, new: next });
          // The variant update replaces all its prices – send every price, changing just the base one
          const all = prices.map((x) => ({
            id: x.id,
            currency_code: x.currency_code,
            amount: x.id === base.id ? next : x.amount,
            ...(x.min_quantity ? { min_quantity: x.min_quantity } : {}),
            ...(x.max_quantity ? { max_quantity: x.max_quantity } : {}),
            ...(x.rules && Object.keys(x.rules).length ? { rules: x.rules } : {}),
          }));
          updates.set(p.id, [...(updates.get(p.id) ?? []), { id: v.id, prices: all }]);
        }
      const summary = {
        currency: cur,
        products: updates.size,
        variants_changed: changes.length,
        variants_without_base_price: missing || undefined,
        preview: changes.slice(0, PREVIEW_ROWS).map(({ product_id: _p, variant_id: _v, ...c }) => c),
        preview_truncated: changes.length > PREVIEW_ROWS || undefined,
      };
      if (a.dry_run || !changes.length)
        return { dry_run: a.dry_run, ...summary, next: changes.length ? "Call again with dry_run: false to apply." : "Nothing to change." };

      const ex = changes[0];
      await confirm(
        extra,
        `Change ${changes.length} ${cur.toUpperCase()} prices on ${updates.size} products (e.g. ${ex.sku ?? ex.variant}: ${ex.old} → ${ex.new})?`,
      );
      const failed: { product_id: string; error: string }[] = [];
      let done = 0;
      for (const [productId, update] of updates) {
        try {
          await medusa.post(`/admin/products/${productId}/variants/batch`, { update });
        } catch (e) {
          failed.push({ product_id: productId, error: errorMessage(e).slice(0, 300) });
        }
        progress(extra, ++done, updates.size, `Updated ${done} of ${updates.size} products`);
      }
      const failedIds = new Set(failed.map((f) => f.product_id));
      return {
        ok: !failed.length,
        applied: changes.filter((c) => !failedIds.has(c.product_id)).length,
        ...summary,
        failed: failed.length ? failed : undefined,
      };
    },
  );

  // ===== Stock =====
  tool(
    "bulk_set_stock",
    {
      title: "Bulk set stock",
      description:
        "Sets stock for many SKUs in one go – e.g. after a delivery or a stock-take. Each row has an absolute stocked_quantity " +
        "or a relative adjust_by. Items not yet stocked at the location are added there. " +
        "dry_run (default true) previews before → after; repeat with dry_run false to apply.",
      inputSchema: {
        items: z
          .array(
            z.object({
              sku: z.string().optional(),
              inventory_item_id: z.string().optional(),
              stocked_quantity: z.number().int().min(0).optional(),
              adjust_by: z.number().int().optional(),
              location_id: z.string().optional(),
            }),
          )
          .min(1)
          .max(500),
        location_id: z.string().optional().describe("Default location for rows without one"),
        dry_run: z.boolean().default(true),
      },
      annotations: DESTRUCTIVE,
      isWrite: (a) => !a.dry_run,
    },
    async (a, extra) => {
      const skus = [...new Set(a.items.map((i) => i.sku).filter(Boolean) as string[])];
      const ids = [...new Set(a.items.map((i) => i.inventory_item_id).filter(Boolean) as string[])];
      const found: any[] = [];
      for (let i = 0; i < skus.length; i += 100)
        found.push(
          ...((await medusa.get("/admin/inventory-items", { sku: skus.slice(i, i + 100), fields: "id,sku,title,*location_levels", limit: 200 }))
            .inventory_items ?? []),
        );
      for (let i = 0; i < ids.length; i += 100)
        found.push(
          ...((await medusa.get("/admin/inventory-items", { id: ids.slice(i, i + 100), fields: "id,sku,title,*location_levels", limit: 200 }))
            .inventory_items ?? []),
        );
      const rows = [];
      const errors: string[] = [];
      const create: any[] = [];
      const update: any[] = [];
      for (const row of a.items) {
        const label = row.sku ?? row.inventory_item_id ?? "?";
        if ((row.stocked_quantity === undefined) === (row.adjust_by === undefined)) {
          errors.push(`${label}: give exactly one of stocked_quantity, adjust_by`);
          continue;
        }
        const matches = found.filter((it) => (row.inventory_item_id ? it.id === row.inventory_item_id : it.sku === row.sku));
        if (matches.length !== 1) {
          errors.push(matches.length ? `${label}: ${matches.length} inventory items match` : `${label}: no inventory item (does the variant track inventory?)`);
          continue;
        }
        const it = matches[0];
        const levels: any[] = it.location_levels ?? [];
        const location = row.location_id ?? a.location_id ?? (levels.length === 1 ? levels[0].location_id : undefined);
        if (!location) {
          errors.push(`${label}: stocked at ${levels.length} locations – give location_id`);
          continue;
        }
        const level = levels.find((l) => l.location_id === location);
        const before = Number(level?.stocked_quantity ?? 0);
        const after = row.stocked_quantity ?? before + row.adjust_by!;
        if (after < 0) {
          errors.push(`${label}: result would be negative (${after})`);
          continue;
        }
        rows.push({ sku: it.sku, title: it.title, location_id: location, before, after, new_location: !level || undefined });
        if (after === before && level) continue;
        (level ? update : create).push({ inventory_item_id: it.id, location_id: location, stocked_quantity: after });
      }
      const summary = {
        rows: rows.length,
        changes: create.length + update.length,
        new_locations: create.length || undefined,
        errors: errors.length ? errors : undefined,
        preview: rows.slice(0, PREVIEW_ROWS * 2),
      };
      if (a.dry_run) return { dry_run: true, ...summary, next: errors.length ? "Fix the errors, then apply with dry_run: false." : "Call again with dry_run: false to apply." };
      if (errors.length) throw new Error(`Nothing was changed – fix these rows first: ${errors.join("; ")}`);
      if (!create.length && !update.length) return { ok: true, ...summary, note: "Nothing to change." };
      await confirm(extra, `Set stock for ${create.length + update.length} items (${rows.map((r) => `${r.sku}: ${r.before}→${r.after}`).slice(0, 3).join(", ")}${rows.length > 3 ? ", …" : ""})?`);
      await medusa.post("/admin/inventory-items/location-levels/batch", defined({ create: create.length ? create : undefined, update: update.length ? update : undefined }));
      return { ok: true, ...summary };
    },
  );

  // ===== Products =====
  tool(
    "bulk_update_products",
    {
      title: "Bulk update products",
      description:
        "Changes many products at once: status (publish / unpublish), categories, collection, tags, sales channels, discountable, shipping profile. " +
        "Targets products by IDs, category, collection, tag, status or search. dry_run (default true) previews; repeat with dry_run false to apply.",
      inputSchema: {
        ...selectionShape,
        set_status: PRODUCT_STATUS.optional(),
        add_category_ids: z.array(z.string()).optional(),
        remove_category_ids: z.array(z.string()).optional(),
        set_collection_id: z.string().nullable().optional().describe("null removes products from their collection"),
        add_tags: z.array(z.string()).optional().describe("Tag values; missing tags are created"),
        remove_tags: z.array(z.string()).optional(),
        add_sales_channel_ids: z.array(z.string()).optional(),
        remove_sales_channel_ids: z.array(z.string()).optional(),
        set_discountable: z.boolean().optional(),
        set_shipping_profile_id: z.string().optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: DESTRUCTIVE,
      isWrite: (a) => !a.dry_run,
    },
    async (a, extra) => {
      const products = await selectProducts(a, "id,title,status,collection_id,discountable,*categories,*tags,*sales_channels");
      const addTags = a.add_tags?.length ? await resolveTagIds(a.add_tags) : [];
      const removeTags = new Set(a.remove_tags ?? []);
      const update: any[] = [];
      const preview = [];
      for (const p of products) {
        const u: Record<string, unknown> = { id: p.id };
        const what: string[] = [];
        if (a.set_status && a.set_status !== p.status) {
          u.status = a.set_status;
          what.push(`status ${p.status} → ${a.set_status}`);
        }
        if (a.set_collection_id !== undefined && a.set_collection_id !== (p.collection_id ?? null)) {
          u.collection_id = a.set_collection_id;
          what.push(a.set_collection_id ? "collection set" : "collection removed");
        }
        if (a.set_discountable !== undefined && a.set_discountable !== p.discountable) {
          u.discountable = a.set_discountable;
          what.push(`discountable → ${a.set_discountable}`);
        }
        if (a.set_shipping_profile_id) {
          u.shipping_profile_id = a.set_shipping_profile_id;
          what.push("shipping profile");
        }
        if (a.add_category_ids?.length || a.remove_category_ids?.length) {
          const cur: string[] = (p.categories ?? []).map((c: any) => c.id);
          const next = [...new Set([...cur, ...(a.add_category_ids ?? [])])].filter((id) => !a.remove_category_ids?.includes(id));
          if (next.length !== cur.length || next.some((id) => !cur.includes(id))) {
            u.categories = next.map((id) => ({ id }));
            what.push(`categories ${cur.length} → ${next.length}`);
          }
        }
        if (addTags.length || removeTags.size) {
          const cur: { id: string; value: string }[] = (p.tags ?? []).map((t: any) => ({ id: t.id, value: t.value }));
          const keep = cur.filter((t) => !removeTags.has(t.value)).map((t) => t.id);
          const next = [...new Set([...keep, ...addTags.map((t) => t.id)])];
          if (next.length !== cur.length || next.some((id) => !cur.some((t) => t.id === id))) {
            u.tags = next.map((id) => ({ id }));
            what.push(`tags ${cur.length} → ${next.length}`);
          }
        }
        const channels: string[] = (p.sales_channels ?? []).map((s: any) => s.id);
        const addCh = (a.add_sales_channel_ids ?? []).filter((id) => !channels.includes(id));
        const remCh = (a.remove_sales_channel_ids ?? []).filter((id) => channels.includes(id));
        if (addCh.length || remCh.length) what.push(`sales channels +${addCh.length} −${remCh.length}`);
        if (Object.keys(u).length > 1) update.push(u);
        if (what.length) preview.push({ id: p.id, title: p.title, changes: what.join(", ") });
      }
      const channelOps = [
        ...(a.add_sales_channel_ids ?? []).map((ch) => ({
          ch,
          add: products.filter((p) => !(p.sales_channels ?? []).some((s: any) => s.id === ch)).map((p) => p.id),
          remove: [] as string[],
        })),
        ...(a.remove_sales_channel_ids ?? []).map((ch) => ({
          ch,
          add: [] as string[],
          remove: products.filter((p) => (p.sales_channels ?? []).some((s: any) => s.id === ch)).map((p) => p.id),
        })),
      ].filter((op) => op.add.length || op.remove.length);
      const summary = {
        selected: products.length,
        changed: preview.length,
        preview: preview.slice(0, PREVIEW_ROWS),
        preview_truncated: preview.length > PREVIEW_ROWS || undefined,
      };
      if (a.dry_run || !preview.length)
        return { dry_run: a.dry_run, ...summary, next: preview.length ? "Call again with dry_run: false to apply." : "Nothing to change." };
      await confirm(extra, `Update ${preview.length} products (${preview[0].title}: ${preview[0].changes}${preview.length > 1 ? ", …" : ""})?`);
      for (let i = 0; i < update.length; i += 50) {
        await medusa.post("/admin/products/batch", { update: update.slice(i, i + 50) });
        progress(extra, Math.min(i + 50, update.length), update.length, "Updating products");
      }
      for (const op of channelOps)
        await medusa.post(`/admin/sales-channels/${op.ch}/products`, defined({ add: op.add.length ? op.add : undefined, remove: op.remove.length ? op.remove : undefined }));
      return { ok: true, ...summary };
    },
  );
}
