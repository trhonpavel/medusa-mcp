import { z } from "zod";
import { defined, DESTRUCTIVE, idList, metadataSchema, RO, UPDATE, type ToolContext } from "./helpers.js";

export function registerCatalogTools(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm } = ctx;

  tool(
    "list_catalog",
    {
      title: "Catalog structure",
      description:
        "Product categories (with parent, so the tree can be rebuilt), collections, tags and product types – with IDs for other tools.",
      inputSchema: {
        q: z.string().optional().describe("Full-text filter applied to every section"),
      },
      annotations: RO,
    },
    async (a) => {
      const [categories, collections, tags, types] = await Promise.all([
        medusa.listAll(
          "/admin/product-categories",
          "product_categories",
          { q: a.q, fields: "id,name,handle,parent_category_id,is_active,is_internal,rank", order: "rank" },
          1000,
        ),
        medusa.listAll("/admin/collections", "collections", { q: a.q, fields: "id,title,handle", order: "title" }, 1000),
        medusa.listAll("/admin/product-tags", "product_tags", { q: a.q, fields: "id,value", order: "value" }, 1000),
        medusa.listAll("/admin/product-types", "product_types", { q: a.q, fields: "id,value", order: "value" }, 1000),
      ]);
      return {
        categories: categories.items.map((c: any) => ({
          id: c.id,
          name: c.name,
          handle: c.handle,
          parent_id: c.parent_category_id ?? undefined,
          active: c.is_active,
          internal: c.is_internal || undefined,
        })),
        collections: collections.items,
        tags: tags.items,
        types: types.items,
      };
    },
  );

  if (cfg.readOnly) return;

  tool(
    "save_category",
    {
      title: "Create or update category",
      description:
        "Without category_id creates a product category (name required); with category_id updates only the given fields. " +
        "Can also add or remove products.",
      inputSchema: {
        category_id: z.string().optional(),
        name: z.string().optional(),
        handle: z.string().optional(),
        description: z.string().optional(),
        parent_category_id: z.string().nullable().optional().describe("null moves it to the top level"),
        is_active: z.boolean().optional().describe("Visible in the storefront (new categories default to inactive in Medusa)"),
        is_internal: z.boolean().optional().describe("Hidden from the storefront"),
        rank: z.number().int().min(0).optional().describe("Position among siblings"),
        metadata: metadataSchema,
        add_products: idList("Product IDs to add"),
        remove_products: idList("Product IDs to remove"),
      },
      annotations: UPDATE,
    },
    async ({ category_id, add_products, remove_products, ...rest }) => {
      const fields = defined(rest);
      let id = category_id;
      let created = false;
      if (!id) {
        if (!fields.name) throw new Error("name is required to create a category.");
        id = (await medusa.post("/admin/product-categories", fields, { fields: "id" })).product_category.id as string;
        created = true;
      } else if (Object.keys(fields).length) {
        await medusa.post(`/admin/product-categories/${id}`, fields, { fields: "id" });
      }
      if (add_products?.length || remove_products?.length)
        await medusa.post(`/admin/product-categories/${id}/products`, defined({ add: add_products, remove: remove_products }), {
          fields: "id",
        });
      const category = (
        await medusa.get(`/admin/product-categories/${id}`, {
          fields: "id,name,handle,description,parent_category_id,is_active,is_internal,rank",
        })
      ).product_category;
      return { ok: true, created, category };
    },
  );

  tool(
    "delete_category",
    {
      title: "Delete category",
      description: "DELETES a product category (products stay, they just lose the category). Confirm with the user first.",
      inputSchema: { category_id: z.string() },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const c = (await medusa.get(`/admin/product-categories/${a.category_id}`, { fields: "id,name" })).product_category;
      await confirm(extra, `Delete category "${c.name}"? Its products stay.`);
      await medusa.delete(`/admin/product-categories/${a.category_id}`);
      return { ok: true, deleted: a.category_id };
    },
  );

  tool(
    "save_collection",
    {
      title: "Create or update collection",
      description:
        "Without collection_id creates a collection (title required); with collection_id updates it. Can add or remove products " +
        "(a product belongs to at most one collection).",
      inputSchema: {
        collection_id: z.string().optional(),
        title: z.string().optional(),
        handle: z.string().optional(),
        metadata: metadataSchema,
        add_products: idList("Product IDs to add"),
        remove_products: idList("Product IDs to remove"),
      },
      annotations: UPDATE,
    },
    async ({ collection_id, add_products, remove_products, ...rest }) => {
      const fields = defined(rest);
      let id = collection_id;
      let created = false;
      if (!id) {
        if (!fields.title) throw new Error("title is required to create a collection.");
        id = (await medusa.post("/admin/collections", fields, { fields: "id" })).collection.id as string;
        created = true;
      } else if (Object.keys(fields).length) {
        await medusa.post(`/admin/collections/${id}`, fields, { fields: "id" });
      }
      if (add_products?.length || remove_products?.length)
        await medusa.post(`/admin/collections/${id}/products`, defined({ add: add_products, remove: remove_products }), {
          fields: "id",
        });
      const collection = (await medusa.get(`/admin/collections/${id}`, { fields: "id,title,handle" })).collection;
      return { ok: true, created, collection };
    },
  );

  tool(
    "delete_collection",
    {
      title: "Delete collection",
      description: "DELETES a collection (products stay, they just leave the collection). Confirm with the user first.",
      inputSchema: { collection_id: z.string() },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const c = (await medusa.get(`/admin/collections/${a.collection_id}`, { fields: "id,title" })).collection;
      await confirm(extra, `Delete collection "${c.title}"? Its products stay.`);
      await medusa.delete(`/admin/collections/${a.collection_id}`);
      return { ok: true, deleted: a.collection_id };
    },
  );
}
