import { z } from "zod";
import {
  CREATE,
  defined,
  DESTRUCTIVE,
  limitSchema,
  offsetSchema,
  optionalBoundary,
  RO,
  UPDATE,
  type ToolContext,
} from "./helpers.js";

const PROMO_FIELDS = "*application_method,*application_method.target_rules,*rules,*campaign";
const TARGETS = { order: "order", items: "items", shipping: "shipping_methods" } as const;

const ruleSchema = z.object({
  attribute: z.string().describe("E.g. customer.groups.id, region.id, shipping_address.country_code, sales_channel_id"),
  operator: z.enum(["in", "eq", "ne", "gt", "gte", "lt", "lte"]).default("in"),
  values: z.array(z.string()).min(1),
});

function shapePromotion(p: any) {
  const am = p.application_method ?? {};
  const rules = (rs: any[] | undefined) =>
    rs?.length
      ? rs.map((r: any) => ({
          attribute: r.attribute,
          operator: r.operator,
          values: (r.values ?? []).map((v: any) => v.value ?? v),
        }))
      : undefined;
  return {
    id: p.id,
    code: p.code,
    status: p.status,
    automatic: p.is_automatic,
    type: p.type,
    discount:
      am.type === "percentage"
        ? `${am.value} %`
        : am.value !== undefined
          ? `${am.value} ${am.currency_code?.toUpperCase() ?? ""}`.trim()
          : undefined,
    applies_to: am.target_type,
    allocation: am.allocation,
    max_quantity: am.max_quantity ?? undefined,
    usage_limit: p.limit ?? undefined,
    used: p.used ?? undefined,
    starts_at: p.campaign?.starts_at ?? undefined,
    ends_at: p.campaign?.ends_at ?? undefined,
    campaign: p.campaign ? { id: p.campaign.id, name: p.campaign.name } : undefined,
    conditions: rules(p.rules),
    target_conditions: rules(am.target_rules),
    created_at: p.created_at,
  };
}

export function registerPromotionTools(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm } = ctx;

  async function resolvePromotion(ref: { promotion_id?: string; code?: string }) {
    if (ref.promotion_id) return (await medusa.get(`/admin/promotions/${ref.promotion_id}`, { fields: PROMO_FIELDS })).promotion;
    if (!ref.code) throw new Error("Provide promotion_id or code.");
    const res = await medusa.get("/admin/promotions", { code: ref.code, fields: PROMO_FIELDS, limit: 5 });
    const hit = (res.promotions ?? []).find((p: any) => p.code.toLowerCase() === ref.code!.toLowerCase());
    if (!hit) throw new Error(`Promotion with code ${ref.code} not found.`);
    return hit;
  }

  tool(
    "list_promotions",
    {
      title: "List promotions",
      description: "Discount codes and automatic promotions with their value, conditions, usage and validity.",
      inputSchema: {
        q: z.string().optional().describe("Search in codes"),
        code: z.string().optional().describe("Exact code"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    async (a) => {
      const res = await medusa.get("/admin/promotions", {
        fields: PROMO_FIELDS,
        q: a.q,
        code: a.code,
        order: "-created_at",
        limit: a.limit,
        offset: a.offset,
      });
      return { count: res.count, offset: res.offset, promotions: (res.promotions ?? []).map(shapePromotion) };
    },
  );

  if (cfg.readOnly) return;

  tool(
    "create_promotion",
    {
      title: "Create promotion",
      description:
        "Creates a discount code (or an automatic promotion): percentage or fixed amount off the order, specific products, or shipping. " +
        "Free shipping = applies_to 'shipping', percentage 100. Restricting to products/categories/collections makes it apply to those items only. " +
        "Plain dates are interpreted in the reporting timezone.",
      inputSchema: {
        code: z.string().describe("The code customers enter, e.g. AUTUMN20"),
        discount_type: z.enum(["percentage", "fixed"]),
        value: z.number().positive().describe("Percent (20 = 20 %) or amount in major units"),
        currency_code: z.string().length(3).optional().describe("Required for a fixed amount, e.g. czk"),
        applies_to: z
          .enum(["order", "items", "shipping"])
          .optional()
          .describe("Defaults to 'items' when restricted to products/categories/collections, otherwise 'order'"),
        product_ids: z.array(z.string()).optional(),
        category_ids: z.array(z.string()).optional(),
        collection_ids: z.array(z.string()).optional(),
        customer_group_ids: z.array(z.string()).optional().describe("Only for customers in these groups"),
        extra_rules: z.array(ruleSchema).optional().describe("Advanced eligibility conditions"),
        allocation: z
          .enum(["each", "across"])
          .optional()
          .describe("'across' (default) splits the discount over the eligible items; 'each' applies it to every unit up to max_quantity"),
        max_quantity: z.number().int().positive().optional().describe("Required with allocation 'each'"),
        is_automatic: z.boolean().default(false).describe("Applies without entering the code"),
        status: z.enum(["active", "draft", "inactive"]).default("active"),
        usage_limit: z.number().int().positive().optional().describe("Total number of uses (not for automatic promotions)"),
        starts_at: z.string().optional().describe("E.g. 2026-11-01"),
        ends_at: z.string().optional().describe("Inclusive, e.g. 2026-11-30"),
      },
      annotations: CREATE,
    },
    async (a) => {
      if (a.discount_type === "fixed" && !a.currency_code) throw new Error("A fixed discount needs currency_code.");
      if (a.discount_type === "percentage" && a.value > 100) throw new Error("A percentage cannot exceed 100.");
      const targetRules = [
        a.product_ids?.length && { attribute: "items.product.id", operator: "in", values: a.product_ids },
        a.category_ids?.length && { attribute: "items.product.categories.id", operator: "in", values: a.category_ids },
        a.collection_ids?.length && { attribute: "items.product.collection_id", operator: "in", values: a.collection_ids },
      ].filter(Boolean) as any[];
      const appliesTo = a.applies_to ?? (targetRules.length ? "items" : "order");
      if (targetRules.length && appliesTo !== "items")
        throw new Error("Product/category/collection restrictions need applies_to 'items'.");
      const target = TARGETS[appliesTo];
      const allocation = a.allocation ?? "across";
      if (target === "order" && allocation !== "across") throw new Error("Order discounts use allocation 'across'.");
      if (allocation === "each" && !a.max_quantity)
        throw new Error("allocation 'each' needs max_quantity – how many units of each item get the discount.");
      if (allocation === "across" && a.max_quantity) throw new Error("max_quantity only works with allocation 'each'.");
      const rules = [
        ...(a.customer_group_ids?.length
          ? [{ attribute: "customer.groups.id", operator: "in", values: a.customer_group_ids }]
          : []),
        ...(a.extra_rules ?? []),
      ];
      const starts = optionalBoundary(a.starts_at, false);
      const ends = optionalBoundary(a.ends_at, true);
      const body = defined({
        code: a.code,
        type: "standard",
        status: a.status,
        is_automatic: a.is_automatic,
        limit: a.usage_limit,
        application_method: defined({
          type: a.discount_type,
          value: a.value,
          currency_code: a.currency_code?.toLowerCase(),
          target_type: target,
          allocation,
          max_quantity: a.max_quantity,
          target_rules: targetRules.length ? targetRules : undefined,
        }),
        rules: rules.length ? rules : undefined,
        campaign:
          starts || ends
            ? defined({ name: a.code, campaign_identifier: `${a.code}-${Date.now()}`, starts_at: starts, ends_at: ends })
            : undefined,
      });
      const p = (await medusa.post("/admin/promotions", body)).promotion;
      const full = (await medusa.get(`/admin/promotions/${p.id}`, { fields: PROMO_FIELDS })).promotion;
      return { ok: true, promotion: shapePromotion(full) };
    },
  );

  tool(
    "update_promotion",
    {
      title: "Update promotion",
      description:
        "Changes a promotion: activate/deactivate (status), rename the code, change the value, usage limit or validity dates. " +
        "Identify it by promotion_id or code.",
      inputSchema: {
        promotion_id: z.string().optional(),
        code: z.string().optional().describe("Current code, to find the promotion"),
        new_code: z.string().optional(),
        status: z.enum(["active", "draft", "inactive"]).optional(),
        value: z.number().positive().optional(),
        usage_limit: z.number().int().positive().nullable().optional().describe("null removes the limit"),
        starts_at: z.string().nullable().optional().describe("null removes the start date"),
        ends_at: z.string().nullable().optional().describe("null removes the end date"),
      },
      annotations: UPDATE,
    },
    async (a) => {
      const p = await resolvePromotion(a);
      const before = shapePromotion(p);
      const starts = optionalBoundary(a.starts_at, false);
      const ends = optionalBoundary(a.ends_at, true);
      let campaignId: string | undefined;
      if (starts !== undefined || ends !== undefined) {
        const dates = defined({ starts_at: starts, ends_at: ends });
        if (p.campaign?.id) await medusa.post(`/admin/campaigns/${p.campaign.id}`, dates);
        else
          campaignId = (
            await medusa.post("/admin/campaigns", { name: p.code, campaign_identifier: `${p.code}-${Date.now()}`, ...dates })
          ).campaign.id;
      }
      const body = defined({
        code: a.new_code,
        status: a.status,
        limit: a.usage_limit,
        campaign_id: campaignId,
        application_method: a.value !== undefined ? { value: a.value } : undefined,
      });
      if (Object.keys(body).length) await medusa.post(`/admin/promotions/${p.id}`, body);
      else if (starts === undefined && ends === undefined) throw new Error("Nothing to update.");
      const after = (await medusa.get(`/admin/promotions/${p.id}`, { fields: PROMO_FIELDS })).promotion;
      return { ok: true, before, after: shapePromotion(after) };
    },
  );

  tool(
    "delete_promotion",
    {
      title: "Delete promotion",
      description:
        "DELETES a promotion – the code stops working. To pause it, prefer update_promotion with status 'inactive'. Confirm with the user first. " +
        "A campaign created for its dates (named after the code) is deleted too.",
      inputSchema: { promotion_id: z.string().optional(), code: z.string().optional() },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const p = await resolvePromotion(a);
      await confirm(extra, `Delete promotion ${p.code}? The code stops working immediately.`);
      await medusa.delete(`/admin/promotions/${p.id}`);
      // create_promotion / update_promotion name the campaign they create after the code
      let campaignDeleted: string | undefined;
      if (p.campaign?.id && p.campaign.name === p.code) {
        const others = await medusa.get("/admin/promotions", { campaign_id: p.campaign.id, fields: "id", limit: 1 });
        if (!(others.promotions ?? []).length) {
          await medusa.delete(`/admin/campaigns/${p.campaign.id}`);
          campaignDeleted = p.campaign.id;
        }
      }
      return { ok: true, deleted: { id: p.id, code: p.code }, campaign_deleted: campaignDeleted };
    },
  );
}
