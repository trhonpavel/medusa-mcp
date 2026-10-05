import { z } from "zod";
import { MedusaError } from "../medusa.js";
import { fetchImage } from "./fetch-image.js";
import {
  CREATE,
  defined,
  DESTRUCTIVE,
  limitSchema,
  metadataSchema,
  normalizePrices,
  offsetSchema,
  priceSchema,
  RO,
  UPDATE,
  type ToolContext,
} from "./helpers.js";

const PRODUCT_STATUS = z.enum(["draft", "proposed", "published", "rejected"]);
const DEFAULT_OPTION = "Default option";
const DEFAULT_OPTION_VALUE = "Default option value";

const variantFields = {
  sku: z.string().optional(),
  barcode: z.string().optional(),
  ean: z.string().optional(),
  upc: z.string().optional(),
  manage_inventory: z.boolean().optional().describe("Track stock (default true)"),
  allow_backorder: z.boolean().optional().describe("Allow selling when out of stock"),
  weight: z.number().nonnegative().optional().describe("Grams"),
};

const newVariantSchema = z.object({
  title: z.string().optional().describe("Defaults to the option values, e.g. 'M / Red'"),
  options: z
    .record(z.string(), z.string())
    .optional()
    .describe("Option title -> value, e.g. { Size: 'M', Color: 'Red' }"),
  prices: z.array(priceSchema).min(1),
  ...variantFields,
  stock: z.number().int().min(0).optional().describe("Initial stocked quantity at location_id (or the only location)"),
});

/** Product detail – shared by get_product and the product resource. Accepts an ID or a handle. */
export async function loadProductDetail(ctx: ToolContext, ref: string) {
  const { medusa } = ctx;
  let id = ref.trim();
  if (!id.startsWith("prod_")) {
    const hit = (await medusa.get("/admin/products", { handle: id, fields: "id", limit: 1 })).products?.[0];
    if (!hit) throw new Error(`Product ${ref} not found (use a product ID or handle).`);
    id = hit.id;
  }
  let p: any;
  try {
    p = (
      await medusa.get(`/admin/products/${id}`, {
        fields:
          "*variants,*variants.prices,*variants.inventory_items,*variants.options,*options,*options.values,*categories," +
          "*collection,*tags,*images,*sales_channels,*shipping_profile",
      })
    ).product;
  } catch (e) {
    if (!(e instanceof MedusaError) || e.status !== 400) throw e;
    p = (await medusa.get(`/admin/products/${id}`, { fields: "*variants,*variants.prices" })).product;
  }
  return {
    id: p.id,
    title: p.title,
    subtitle: p.subtitle,
    handle: p.handle,
    status: p.status,
    description: p.description,
    collection: p.collection ? { id: p.collection.id, title: p.collection.title } : undefined,
    categories: (p.categories ?? []).map((c: any) => ({ id: c.id, name: c.name })),
    tags: (p.tags ?? []).map((t: any) => t.value),
    thumbnail: p.thumbnail,
    images: (p.images ?? []).map((i: any) => i.url),
    sales_channels: p.sales_channels ? p.sales_channels.map((s: any) => s.name ?? s.id) : undefined,
    shipping_profile: p.shipping_profile?.name,
    discountable: p.discountable,
    weight: p.weight ?? undefined,
    options: (p.options ?? []).map((o: any) => ({ id: o.id, title: o.title, values: (o.values ?? []).map((v: any) => v.value) })),
    variants: (p.variants ?? []).map((v: any) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode ?? undefined,
      ean: v.ean ?? undefined,
      options: v.options ? Object.fromEntries(v.options.map((o: any) => [o.option?.title ?? o.option_id, o.value])) : undefined,
      manage_inventory: v.manage_inventory,
      allow_backorder: v.allow_backorder,
      weight: v.weight ?? undefined,
      prices: (v.prices ?? []).map((pr: any) => ({
        currency: pr.currency_code,
        amount: pr.amount,
        rules: pr.rules && Object.keys(pr.rules).length ? pr.rules : undefined,
        min_quantity: pr.min_quantity ?? undefined,
      })),
      inventory_item_ids: (v.inventory_items ?? []).map((i: any) => i.inventory_item_id),
    })),
    metadata: p.metadata,
    updated_at: p.updated_at,
  };
}

export function registerProductTools(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm, resolveLocationId, resolveTagIds } = ctx;

  async function loadProduct(id: string, fields: string) {
    return (await medusa.get(`/admin/products/${id}`, { fields })).product;
  }

  /** Sets initial stock for newly created variants that track inventory. */
  async function stockNewVariants(productId: string, wanted: { sku?: string; title?: string; stock?: number }[], locationId?: string) {
    const todo = wanted.filter((w) => w.stock !== undefined);
    if (!todo.length) return [];
    const location = await resolveLocationId(locationId);
    const p = await loadProduct(productId, "id,*variants,*variants.inventory_items");
    const out: { sku?: string; inventory_item_id?: string; stocked: number | string }[] = [];
    for (const w of todo) {
      const v = (p.variants ?? []).find((x: any) => (w.sku && x.sku === w.sku) || (!w.sku && x.title === w.title));
      const itemId = v?.inventory_items?.[0]?.inventory_item_id;
      if (!itemId) {
        out.push({ sku: w.sku, stocked: "skipped – variant does not track inventory" });
        continue;
      }
      await medusa.post(`/admin/inventory-items/${itemId}/location-levels`, {
        location_id: location,
        stocked_quantity: w.stock,
      });
      out.push({ sku: w.sku, inventory_item_id: itemId, stocked: w.stock! });
    }
    return out;
  }

  /** Deletes inventory items left behind by deleted variants – only those with nothing reserved. */
  async function removeInventoryItems(ids: string[]) {
    const out: { id: string; sku?: string; result: string }[] = [];
    for (const id of ids) {
      let item: any;
      try {
        item = (await medusa.get(`/admin/inventory-items/${id}`, { fields: "id,sku,reserved_quantity" })).inventory_item;
      } catch (e) {
        if (e instanceof MedusaError && e.status === 404) {
          out.push({ id, result: "already deleted" });
          continue;
        }
        throw e;
      }
      if (Number(item.reserved_quantity ?? 0) > 0) {
        out.push({ id, sku: item.sku, result: `kept – ${item.reserved_quantity} reserved` });
        continue;
      }
      await medusa.delete(`/admin/inventory-items/${id}`);
      out.push({ id, sku: item.sku, result: "deleted" });
    }
    return out;
  }

  function variantTitle(v: { title?: string; options?: Record<string, string> }, fallback: string) {
    return v.title ?? (v.options && Object.keys(v.options).length ? Object.values(v.options).join(" / ") : fallback);
  }

  // ===== Read =====
  tool(
    "list_products",
    {
      title: "List products",
      description: "Lists products with their variants (SKUs). Filter by full-text, status, collection, category or tag.",
      inputSchema: {
        q: z.string().optional(),
        status: z.array(PRODUCT_STATUS).optional(),
        collection_id: z.string().optional(),
        category_id: z.string().optional(),
        tag_id: z.string().optional(),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    async (a) => {
      const res = await medusa.get("/admin/products", {
        fields: "id,title,handle,status,created_at,updated_at,variants.id,variants.title,variants.sku",
        order: "-updated_at",
        q: a.q,
        status: a.status,
        collection_id: a.collection_id ? [a.collection_id] : undefined,
        category_id: a.category_id ? [a.category_id] : undefined,
        tag_id: a.tag_id ? [a.tag_id] : undefined,
        limit: a.limit,
        offset: a.offset,
      });
      return {
        count: res.count,
        offset: res.offset,
        products: (res.products ?? []).map((p: any) => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          status: p.status,
          updated_at: p.updated_at,
          variants: (p.variants ?? []).map((v: any) => ({ id: v.id, title: v.title, sku: v.sku })),
        })),
      };
    },
  );

  tool(
    "get_product",
    {
      title: "Get product",
      description:
        "Product detail – variants, prices in all currencies, linked inventory items, options, categories, collection, tags, images and sales channels.",
      inputSchema: { product_id: z.string().describe("Product ID (prod_…) or handle") },
      annotations: RO,
    },
    async (a) => loadProductDetail(ctx, a.product_id),
  );

  if (cfg.readOnly) return;

  // ===== Write =====
  tool(
    "create_product",
    {
      title: "Create product",
      description:
        "Creates a product with its variants and prices. For a simple product without options pass just 'prices' (and optionally 'sku', 'stock'). " +
        "For variants define 'options' (e.g. Size: S, M, L) and one variant per combination. " +
        "Defaults: status draft, the store's default sales channel, the default shipping profile. Category and collection IDs come from list_catalog.",
      inputSchema: {
        title: z.string(),
        subtitle: z.string().optional(),
        description: z.string().optional(),
        handle: z.string().optional().describe("URL slug; derived from the title when omitted"),
        status: PRODUCT_STATUS.default("draft"),
        thumbnail: z.string().optional().describe("Image URL"),
        images: z.array(z.string()).optional().describe("Image URLs"),
        collection_id: z.string().optional(),
        category_ids: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional().describe("Tag values; missing tags are created"),
        sales_channel_ids: z.array(z.string()).optional(),
        shipping_profile_id: z.string().optional(),
        discountable: z.boolean().optional(),
        weight: z.number().nonnegative().optional().describe("Grams"),
        metadata: z.record(z.string(), z.any()).optional(),
        options: z
          .array(z.object({ title: z.string(), values: z.array(z.string()).min(1) }))
          .optional()
          .describe("E.g. [{ title: 'Size', values: ['S','M','L'] }]"),
        variants: z.array(newVariantSchema).optional(),
        prices: z.array(priceSchema).optional().describe("Simple product: prices of its single variant"),
        sku: z.string().optional().describe("Simple product: SKU of its single variant"),
        stock: z.number().int().min(0).optional().describe("Simple product: initial stock"),
        location_id: z.string().optional().describe("Stock location for initial stock; defaults to the only one"),
      },
      annotations: CREATE,
    },
    async (a) => {
      let options = a.options;
      let variants = a.variants;
      if (!variants?.length) {
        if (!a.prices?.length) throw new Error("Provide 'variants', or 'prices' for a simple product.");
        if (options?.length) throw new Error("A product with options needs 'variants' – one per option combination.");
        variants = [{ title: a.title, prices: a.prices, sku: a.sku, stock: a.stock }];
      }
      if (!options?.length) {
        if (variants.length > 1) throw new Error("Multiple variants need 'options' to tell them apart.");
        options = [{ title: DEFAULT_OPTION, values: [DEFAULT_OPTION_VALUE] }];
        variants = variants.map((v) => ({ ...v, options: { [DEFAULT_OPTION]: DEFAULT_OPTION_VALUE } }));
      }
      for (const v of variants) {
        for (const o of options) {
          const val = v.options?.[o.title];
          if (!val) throw new Error(`Variant ${v.sku ?? v.title ?? ""} is missing a value for option "${o.title}".`);
          if (!o.values.includes(val)) o.values.push(val);
        }
      }

      let salesChannels = a.sales_channel_ids?.map((id) => ({ id }));
      if (!salesChannels) {
        const store = (await medusa.get("/admin/stores", { fields: "id,default_sales_channel_id" })).stores?.[0];
        if (store?.default_sales_channel_id) salesChannels = [{ id: store.default_sales_channel_id }];
      }
      let shippingProfileId = a.shipping_profile_id;
      if (!shippingProfileId) {
        const profiles: any[] = (await medusa.get("/admin/shipping-profiles", { fields: "id,type", limit: 100 }))
          .shipping_profiles ?? [];
        shippingProfileId = (profiles.find((p) => p.type === "default") ?? (profiles.length === 1 ? profiles[0] : undefined))?.id;
      }

      const body = defined({
        title: a.title,
        subtitle: a.subtitle,
        description: a.description,
        handle: a.handle,
        status: a.status,
        thumbnail: a.thumbnail ?? a.images?.[0],
        images: a.images?.map((url) => ({ url })),
        collection_id: a.collection_id,
        categories: a.category_ids?.map((id) => ({ id })),
        tags: a.tags ? await resolveTagIds(a.tags) : undefined,
        sales_channels: salesChannels,
        shipping_profile_id: shippingProfileId,
        discountable: a.discountable,
        weight: a.weight,
        metadata: a.metadata,
        options,
        variants: variants.map((v) =>
          defined({
            title: variantTitle(v, a.title),
            options: v.options,
            prices: normalizePrices(v.prices),
            sku: v.sku,
            barcode: v.barcode,
            ean: v.ean,
            upc: v.upc,
            manage_inventory: v.manage_inventory,
            allow_backorder: v.allow_backorder,
            weight: v.weight,
          }),
        ),
      });
      const p = (await medusa.post("/admin/products", body, { fields: "id,title,handle,status,*variants" })).product;
      const stock = await stockNewVariants(
        p.id,
        variants.map((v) => ({ sku: v.sku, title: variantTitle(v, a.title), stock: v.stock })),
        a.location_id,
      );
      return {
        ok: true,
        product: { id: p.id, title: p.title, handle: p.handle, status: p.status },
        variants: (p.variants ?? []).map((v: any) => ({ id: v.id, title: v.title, sku: v.sku })),
        stock: stock.length ? stock : undefined,
      };
    },
  );

  tool(
    "update_product",
    {
      title: "Update product",
      description:
        "Updates product fields – texts, status, handle, images, collection, categories, tags, sales channels, metadata. " +
        "Send only the fields that should change. Lists (category_ids, tags, images, sales_channel_ids) replace the previous list.",
      inputSchema: {
        product_id: z.string(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        description: z.string().optional(),
        handle: z.string().optional(),
        status: PRODUCT_STATUS.optional(),
        thumbnail: z.string().optional(),
        images: z.array(z.string()).optional().describe("Image URLs – replaces all images"),
        collection_id: z.string().nullable().optional().describe("null removes the product from its collection"),
        category_ids: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional().describe("Tag values; missing tags are created"),
        sales_channel_ids: z.array(z.string()).optional(),
        shipping_profile_id: z.string().optional(),
        discountable: z.boolean().optional(),
        weight: z.number().nonnegative().optional(),
        metadata: metadataSchema,
      },
      annotations: UPDATE,
    },
    async ({ product_id, images, category_ids, tags, sales_channel_ids, ...fields }) => {
      const body: Record<string, unknown> = defined({
        ...fields,
        images: images?.map((url) => ({ url })),
        categories: category_ids?.map((id) => ({ id })),
        tags: tags ? await resolveTagIds(tags) : undefined,
        sales_channels: sales_channel_ids?.map((id) => ({ id })),
      });
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      const view = "id,title,subtitle,handle,status,thumbnail,collection_id,discountable,weight,*categories,*tags,*sales_channels";
      const shape = (p: any) => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        handle: p.handle,
        status: p.status,
        thumbnail: p.thumbnail,
        collection_id: p.collection_id,
        categories: p.categories?.map((c: any) => c.name),
        tags: p.tags?.map((t: any) => t.value),
        sales_channels: p.sales_channels?.map((s: any) => s.name ?? s.id),
      });
      const before = await loadProduct(product_id, view);
      const res = await medusa.post(`/admin/products/${product_id}`, body, { fields: view });
      return { ok: true, before: shape(before), after: shape(res.product) };
    },
  );

  tool(
    "delete_product",
    {
      title: "Delete product",
      description:
        "DELETES the product with all its variants. Irreversible – get explicit confirmation from the user before calling. " +
        "'confirm_title' must match the product title exactly. By default the inventory items of its variants are deleted too " +
        "(only those with nothing reserved).",
      inputSchema: {
        product_id: z.string(),
        confirm_title: z.string().describe("The exact product title, as a safeguard against deleting the wrong product"),
        delete_inventory_items: z.boolean().default(true),
      },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const p = await loadProduct(a.product_id, "id,title,handle,status,*variants,*variants.inventory_items");
      if (p.title !== a.confirm_title)
        throw new Error(`confirm_title does not match – the product is titled "${p.title}".`);
      await confirm(
        extra,
        `Delete product "${p.title}" (${p.status}) with ${(p.variants ?? []).length} variant(s)? This cannot be undone.`,
      );
      const inventoryItemIds = [
        ...new Set<string>(
          (p.variants ?? []).flatMap((v: any) => (v.inventory_items ?? []).map((i: any) => i.inventory_item_id)),
        ),
      ].filter(Boolean);

      await medusa.delete(`/admin/products/${p.id}`);

      const inventory = a.delete_inventory_items ? await removeInventoryItems(inventoryItemIds) : [];
      return {
        ok: true,
        deleted_product: { id: p.id, title: p.title, handle: p.handle, status: p.status },
        variants_deleted: (p.variants ?? []).map((v: any) => ({ id: v.id, sku: v.sku })),
        inventory_items: a.delete_inventory_items ? inventory : inventoryItemIds.map((id) => ({ id, result: "kept" })),
      };
    },
  );

  tool(
    "add_product_images",
    {
      title: "Add product images",
      description:
        "Adds images to a product from public image URLs. By default they are downloaded and stored in the shop's own file storage " +
        "(so the storefront does not depend on the source site). Optionally makes the first one the thumbnail.",
      inputSchema: {
        product_id: z.string(),
        urls: z.array(z.string().url()).min(1).max(10),
        store_copy: z.boolean().default(true).describe("Upload a copy to the shop's storage instead of linking the URL"),
        set_thumbnail: z.boolean().default(false).describe("Make the first new image the thumbnail"),
      },
      annotations: CREATE,
    },
    async (a) => {
      const p = await loadProduct(a.product_id, "id,title,thumbnail,*images");
      let urls = a.urls;
      let uploaded: { id: string; url: string }[] | undefined;
      if (a.store_copy) {
        const files = [];
        for (const u of a.urls) files.push(await fetchImage(u));
        uploaded = await medusa.upload(files);
        urls = uploaded.map((f) => f.url);
      }
      const images = [...(p.images ?? []).map((i: any) => ({ id: i.id, url: i.url })), ...urls.map((url) => ({ url }))];
      const body: Record<string, unknown> = { images };
      if (a.set_thumbnail || !p.thumbnail) body.thumbnail = urls[0];
      const res = await medusa.post(`/admin/products/${p.id}`, body, { fields: "id,thumbnail,*images" });
      return {
        ok: true,
        product: { id: p.id, title: p.title },
        added: urls,
        uploaded_files: uploaded,
        thumbnail: res.product?.thumbnail,
        images: (res.product?.images ?? []).length,
      };
    },
  );

  // ===== Variants =====
  tool(
    "create_variant",
    {
      title: "Create variant",
      description:
        "Adds a variant to an existing product, e.g. a new size. 'options' must name every product option; new option values are added automatically.",
      inputSchema: {
        product_id: z.string(),
        ...newVariantSchema.shape,
        location_id: z.string().optional().describe("Stock location for initial stock; defaults to the only one"),
      },
      annotations: CREATE,
    },
    async (a) => {
      const p = await loadProduct(a.product_id, "id,title,*options,*options.values");
      const productOptions: any[] = p.options ?? [];
      const given = a.options ?? {};
      if (productOptions.length === 1 && !Object.keys(given).length && productOptions[0].title === DEFAULT_OPTION)
        throw new Error(
          "The product has no real options (only the default one) – add an option in the admin first, " +
            "or create a separate product.",
        );
      for (const o of productOptions) {
        const val = given[o.title];
        if (!val) throw new Error(`Missing value for option "${o.title}" (product options: ${productOptions.map((x) => x.title).join(", ")}).`);
        const values: string[] = (o.values ?? []).map((v: any) => v.value);
        if (!values.includes(val))
          await medusa.post(`/admin/products/${p.id}/options/${o.id}`, { values: [...values, val] });
      }
      const unknown = Object.keys(given).filter((k) => !productOptions.some((o) => o.title === k));
      if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);

      const title = variantTitle(a, p.title);
      const res = await medusa.post(
        `/admin/products/${p.id}/variants`,
        defined({
          title,
          options: given,
          prices: normalizePrices(a.prices),
          sku: a.sku,
          barcode: a.barcode,
          ean: a.ean,
          upc: a.upc,
          manage_inventory: a.manage_inventory,
          allow_backorder: a.allow_backorder,
          weight: a.weight,
        }),
        { fields: "id,*variants" },
      );
      const v = (res.product?.variants ?? []).find((x: any) => (a.sku ? x.sku === a.sku : x.title === title));
      const stock = await stockNewVariants(p.id, [{ sku: a.sku, title, stock: a.stock }], a.location_id);
      return { ok: true, product_id: p.id, variant: v ? { id: v.id, title: v.title, sku: v.sku } : undefined, stock: stock[0] };
    },
  );

  tool(
    "update_variant",
    {
      title: "Update variant",
      description:
        "Updates variant fields – title, SKU, barcodes, inventory tracking, backorders, weight, metadata. For prices use set_variant_price.",
      inputSchema: {
        product_id: z.string(),
        variant_id: z.string(),
        title: z.string().optional(),
        ...variantFields,
        metadata: metadataSchema,
      },
      annotations: UPDATE,
    },
    async ({ product_id, variant_id, ...fields }) => {
      const body = defined(fields);
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      const path = `/admin/products/${product_id}/variants/${variant_id}`;
      const view = "id,title,sku,barcode,ean,upc,manage_inventory,allow_backorder,weight";
      const before = (await medusa.get(path, { fields: view })).variant;
      await medusa.post(path, body);
      const after = (await medusa.get(path, { fields: view })).variant;
      return { ok: true, before, after };
    },
  );

  tool(
    "delete_variant",
    {
      title: "Delete variant",
      description:
        "DELETES one variant of a product. Irreversible – confirm with the user first. 'confirm' must equal the variant's SKU (or its title when it has no SKU). " +
        "By default its inventory item is deleted too (only when nothing is reserved).",
      inputSchema: {
        product_id: z.string(),
        variant_id: z.string(),
        confirm: z.string().describe("The variant's exact SKU, or title when it has no SKU"),
        delete_inventory_items: z.boolean().default(true),
      },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const path = `/admin/products/${a.product_id}/variants/${a.variant_id}`;
      const v = (await medusa.get(path, { fields: "id,title,sku,*inventory_items" })).variant;
      const expected = v.sku || v.title;
      if (a.confirm !== expected) throw new Error(`confirm does not match – expected "${expected}".`);
      await confirm(extra, `Delete variant "${v.title}"${v.sku ? ` (${v.sku})` : ""}? This cannot be undone.`);
      const inventoryItemIds: string[] = (v.inventory_items ?? []).map((i: any) => i.inventory_item_id).filter(Boolean);
      await medusa.delete(path);
      return {
        ok: true,
        deleted_variant: { id: v.id, title: v.title, sku: v.sku },
        inventory_items: a.delete_inventory_items
          ? await removeInventoryItems(inventoryItemIds)
          : inventoryItemIds.map((id) => ({ id, result: "kept" })),
      };
    },
  );

  tool(
    "set_variant_price",
    {
      title: "Set variant price",
      description:
        "Sets the base price (no price rules) of a variant in one currency. All other prices of the variant are preserved. " +
        "The amount is in major currency units (e.g. 49.99 = 49.99 EUR). For sale or customer-group prices use price lists.",
      inputSchema: {
        product_id: z.string(),
        variant_id: z.string(),
        currency_code: z.string().length(3).describe("E.g. eur, usd"),
        amount: z.number().nonnegative(),
      },
      annotations: UPDATE,
    },
    async (a) => {
      const cur = a.currency_code.toLowerCase();
      const path = `/admin/products/${a.product_id}/variants/${a.variant_id}`;
      const v = (await medusa.get(path, { fields: "id,title,sku,*prices" })).variant;
      const prices: any[] = v.prices ?? [];
      const isBase = (p: any) => p.currency_code === cur && (!p.rules || !Object.keys(p.rules).length) && !p.min_quantity;
      const before = prices.find(isBase)?.amount;
      // Medusa replaces the whole prices array – send all existing prices (with ids), changing or adding just one.
      const next = prices.map((p) => ({
        id: p.id,
        currency_code: p.currency_code,
        amount: isBase(p) ? a.amount : p.amount,
        ...(p.min_quantity ? { min_quantity: p.min_quantity } : {}),
        ...(p.max_quantity ? { max_quantity: p.max_quantity } : {}),
        ...(p.rules && Object.keys(p.rules).length ? { rules: p.rules } : {}),
      }));
      if (before === undefined) next.push({ currency_code: cur, amount: a.amount } as any);
      await medusa.post(path, { prices: next });
      return { ok: true, variant: { id: v.id, title: v.title, sku: v.sku }, currency: cur, before, after: a.amount };
    },
  );
}
