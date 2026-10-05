import { z } from "zod";
import { limitSchema, offsetSchema, RO, type ToolContext } from "./helpers.js";

export function registerInventoryTools(ctx: ToolContext) {
  const { tool, medusa, cfg } = ctx;

  tool(
    "list_inventory",
    {
      title: "Inventory levels",
      description:
        "Inventory items with stock per location (stocked, reserved, available). With low_stock_threshold returns only items at or below the threshold.",
      inputSchema: {
        q: z.string().optional().describe("Full-text search – title, SKU"),
        sku: z.string().optional().describe("Exact SKU"),
        location_id: z.string().optional().describe("Only this stock location"),
        low_stock_threshold: z
          .number()
          .int()
          .optional()
          .describe("Only return items whose available quantity is less than or equal to this value"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    async (a) => {
      const base = { fields: "id,sku,title,*location_levels", q: a.q, sku: a.sku, order: "sku" };
      const shape = (it: any) => {
        const levels = (it.location_levels ?? [])
          .filter((l: any) => !a.location_id || l.location_id === a.location_id)
          .map((l: any) => ({
            location_id: l.location_id,
            stocked: l.stocked_quantity,
            reserved: l.reserved_quantity,
            available: l.available_quantity ?? Number(l.stocked_quantity ?? 0) - Number(l.reserved_quantity ?? 0),
            incoming: l.incoming_quantity || undefined,
          }));
        return {
          id: it.id,
          sku: it.sku,
          title: it.title,
          available_total: levels.reduce((s: number, l: any) => s + Number(l.available ?? 0), 0),
          levels,
        };
      };
      if (a.low_stock_threshold !== undefined) {
        const all = await medusa.listAll("/admin/inventory-items", "inventory_items", base, 5000);
        const low = all.items
          .map(shape)
          .filter((i) => i.available_total <= a.low_stock_threshold!)
          .sort((x, y) => x.available_total - y.available_total);
        return {
          count: low.length,
          scanned: all.items.length,
          items: low.slice(a.offset, a.offset + a.limit),
        };
      }
      const res = await medusa.get("/admin/inventory-items", { ...base, limit: a.limit, offset: a.offset });
      return { count: res.count, offset: res.offset, items: (res.inventory_items ?? []).map(shape) };
    },
  );

  if (cfg.readOnly) return;

  tool(
    "set_stock_level",
    {
      title: "Set stock level",
      description:
        "Sets the stocked quantity of an item at a location. Provide either an absolute 'stocked_quantity' or a relative 'adjust_by' (+/-). " +
        "Identify the item by inventory_item_id or SKU. Without location_id the item's only location is used. " +
        "If the item is not stocked at the given location yet, it is added there.",
      inputSchema: {
        inventory_item_id: z.string().optional(),
        sku: z.string().optional(),
        location_id: z.string().optional(),
        stocked_quantity: z.number().int().min(0).optional(),
        adjust_by: z.number().int().optional().describe("E.g. +10 when restocking, -2 when writing off"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      if ((a.stocked_quantity === undefined) === (a.adjust_by === undefined))
        throw new Error("Provide exactly one of: stocked_quantity, adjust_by.");
      let item: any;
      if (a.inventory_item_id) {
        item = (
          await medusa.get(`/admin/inventory-items/${a.inventory_item_id}`, { fields: "id,sku,title,*location_levels" })
        ).inventory_item;
      } else if (a.sku) {
        const res = await medusa.get("/admin/inventory-items", {
          sku: a.sku,
          fields: "id,sku,title,*location_levels",
          limit: 2,
        });
        const found = (res.inventory_items ?? []).length;
        if (found === 0)
          throw new Error(
            `No inventory item with SKU ${a.sku}. If the variant exists, it probably does not track inventory ` +
              "(manage_inventory = false) – enable it with update_variant first.",
          );
        if (found !== 1) throw new Error(`SKU ${a.sku}: found ${res.count ?? found} inventory items, expected 1.`);
        item = res.inventory_items[0];
      } else throw new Error("Provide inventory_item_id or sku.");

      const levels: any[] = item.location_levels ?? [];
      let level = a.location_id ? levels.find((l) => l.location_id === a.location_id) : undefined;
      if (!a.location_id) {
        if (levels.length !== 1)
          throw new Error(
            levels.length === 0
              ? `Item ${item.sku ?? item.id} is not stocked at any location yet – specify location_id to add it.`
              : `The item is stocked at ${levels.length} locations, specify location_id: ${levels.map((l) => l.location_id).join(", ")}`,
          );
        level = levels[0];
      }
      if (!level) {
        // Not stocked at this location yet -> create the level
        const after = a.stocked_quantity ?? a.adjust_by!;
        if (after < 0) throw new Error(`The resulting quantity would be negative (${after}).`);
        await medusa.post(`/admin/inventory-items/${item.id}/location-levels`, {
          location_id: a.location_id,
          stocked_quantity: after,
        });
        return {
          ok: true,
          inventory_item: { id: item.id, sku: item.sku, title: item.title },
          location_id: a.location_id,
          location_added: true,
          stocked_before: 0,
          stocked_after: after,
        };
      }
      const before = Number(level.stocked_quantity ?? 0);
      const after = a.stocked_quantity ?? before + a.adjust_by!;
      if (after < 0) throw new Error(`The resulting quantity would be negative (${after}).`);
      await medusa.post(`/admin/inventory-items/${item.id}/location-levels/${level.location_id}`, {
        stocked_quantity: after,
      });
      return {
        ok: true,
        inventory_item: { id: item.id, sku: item.sku, title: item.title },
        location_id: level.location_id,
        stocked_before: before,
        stocked_after: after,
        reserved: level.reserved_quantity,
      };
    },
  );
}
