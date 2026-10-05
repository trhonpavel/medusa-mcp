import { appendFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { MedusaClient, MedusaError } from "../medusa.js";
import type { MedusaConfig } from "../config.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Thrown when the user declines a confirmation; reported as a canceled action, not as an error. */
export class Declined extends Error {}

// ---------- results ----------

const MAX_OUTPUT = 80_000;

/** Nulls carry no information for the model – dropping them saves a lot of tokens on Medusa objects. */
const dropNulls = (_k: string, v: unknown) => (v === null ? undefined : v);

export function ok(data: unknown, structured = false): CallToolResult {
  let text = JSON.stringify(data, dropNulls) ?? "null";
  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT) + "\n…(output truncated – narrow the filter or lower the limit)";
  }
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured && data && typeof data === "object" && !Array.isArray(data))
    result.structuredContent = JSON.parse(JSON.stringify(data, dropNulls));
  return result;
}

export function errorMessage(e: unknown): string {
  return e instanceof MedusaError
    ? `${e.message}${e.body && typeof e.body === "object" ? `\n${JSON.stringify(e.body)}` : ""}`
    : e instanceof Error
      ? e.message
      : String(e);
}

export function fail(e: unknown): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(e)}` }], isError: true };
}

/** Drops undefined values so only the fields the caller set are sent to Medusa. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const money = (amount: unknown, currency?: string) =>
  `${Number(amount ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${(currency ?? "").toUpperCase()}`.trim();

// ---------- dates ----------

export const DEFAULT_TZ = process.env.REPORT_TIMEZONE || "UTC";

/** Timezone offset (ms) at a given instant. */
function tzOffsetMs(tz: string, instant: number): number {
  // Intl only resolves to whole seconds – work on a whole-second instant so ms don't leak into the offset
  const at = Math.floor(instant / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - at;
}

/** "2026-09-01" in a timezone -> UTC ISO of the start (or end) of that day. Full ISO timestamps pass through. */
export function zonedBoundary(input: string, tz: string, endOfDay: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) {
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
    return d.toISOString();
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const naive = endOfDay ? Date.UTC(y, mo, d, 23, 59, 59, 999) : Date.UTC(y, mo, d, 0, 0, 0, 0);
  const off = tzOffsetMs(tz, naive);
  return new Date(naive - off).toISOString();
}

export function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

export function isoWeekKey(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function dateFilter(from?: string, to?: string, tz = DEFAULT_TZ) {
  if (!from && !to) return undefined;
  const f: Record<string, string> = {};
  if (from) f.$gte = zonedBoundary(from, tz, false);
  if (to) f.$lte = zonedBoundary(to, tz, true);
  return f;
}

/** Optional start/end timestamp: plain dates are the start (or end) of that day in the reporting timezone. */
export function optionalBoundary(input: string | null | undefined, endOfDay: boolean) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  return zonedBoundary(input, DEFAULT_TZ, endOfDay);
}

// ---------- orders ----------

export function summarizeOrder(o: any) {
  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || undefined;
  return {
    id: o.id,
    display_id: o.display_id,
    created_at: o.created_at,
    status: o.status,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    email: o.email,
    customer: name,
    total: o.total,
    currency: o.currency_code,
    items: Array.isArray(o.items) ? o.items.reduce((s: number, i: any) => s + Number(i.quantity ?? 0), 0) : undefined,
    ship_to: o.shipping_address
      ? [o.shipping_address.city, o.shipping_address.country_code?.toUpperCase()].filter(Boolean).join(", ")
      : undefined,
  };
}

export const ORDER_LIST_FIELDS =
  "id,display_id,status,payment_status,fulfillment_status,email,total,currency_code,created_at," +
  "customer.first_name,customer.last_name,shipping_address.city,shipping_address.country_code,items.quantity";

export const PAYMENT_STATUSES = [
  "not_paid",
  "awaiting",
  "authorized",
  "partially_authorized",
  "captured",
  "partially_captured",
  "partially_refunded",
  "refunded",
  "canceled",
  "requires_action",
] as const;
export const FULFILLMENT_STATUSES = [
  "not_fulfilled",
  "partially_fulfilled",
  "fulfilled",
  "partially_shipped",
  "shipped",
  "partially_delivered",
  "delivered",
  "canceled",
] as const;

// ---------- schemas ----------

export const limitSchema = z.number().int().min(1).max(200).default(20).describe("Number of records (max 200)");
export const offsetSchema = z.number().int().min(0).default(0).describe("Records to skip (pagination)");
export const metadataSchema = z
  .record(z.string(), z.any())
  .optional()
  .describe("Merged into existing metadata; an empty string deletes a key");
export const idList = (what: string) => z.array(z.string()).optional().describe(what);

export const addressSchema = z
  .object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company: z.string().optional(),
    address_1: z.string().optional(),
    address_2: z.string().optional(),
    city: z.string().optional(),
    postal_code: z.string().optional(),
    province: z.string().optional(),
    country_code: z.string().optional().describe("ISO 3166-1 alpha-2, lowercase, e.g. cz"),
    phone: z.string().optional(),
  })
  .describe("Postal address");

export const priceSchema = z.object({
  currency_code: z.string().length(3).describe("E.g. eur, czk"),
  amount: z.number().nonnegative().describe("Major units, e.g. 49.99"),
});

export function normalizePrices(prices: { currency_code: string; amount: number }[] = []) {
  return prices.map((p) => ({ currency_code: p.currency_code.toLowerCase(), amount: p.amount }));
}

// ---------- annotations ----------

export const RO = { readOnlyHint: true, openWorldHint: false } as const;
/** Creates something new; repeating the call creates another one. */
export const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Sets fields to given values; repeating the call changes nothing. */
export const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Deletes, cancels or moves money. */
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

// ---------- shared context ----------

type ToolConfig<S extends ZodRawShapeCompat> = {
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  _meta?: Record<string, unknown>;
  /** Also return the result as structuredContent (read by UI views). */
  structured?: boolean;
  /** Whether a call changes data and belongs in the audit log; defaults to "not readOnlyHint". */
  isWrite?: (args: ShapeOutput<S>) => boolean;
};

export function createContext(server: McpServer, medusa: MedusaClient, cfg: MedusaConfig) {
  function clientLabel(extra: Extra): string {
    const info = extra.authInfo;
    if (!info) return "stdio";
    const name = info.extra?.clientName;
    return typeof name === "string" && name ? `${name} (${info.clientId})` : info.clientId;
  }

  /** One line per write call on stderr (docker logs), and in AUDIT_LOG when set. */
  function audit(extra: Extra, tool: string, args: unknown, outcome: Record<string, unknown>) {
    let argText = JSON.stringify(args) ?? "";
    if (argText.length > 2000) argText = argText.slice(0, 2000) + "…";
    const line = JSON.stringify({ at: new Date().toISOString(), tool, client: clientLabel(extra), ...outcome, args: argText });
    console.error(`[audit] ${line}`);
    if (cfg.auditLog)
      appendFile(cfg.auditLog, line + "\n").catch((e) => console.error(`[medusa-mcp] cannot write AUDIT_LOG: ${e?.message ?? e}`));
  }

  /** Registers a tool: errors become isError results, writes are audited, user cancellations are reported as such. */
  function tool<S extends ZodRawShapeCompat>(
    name: string,
    config: ToolConfig<S>,
    handler: (args: ShapeOutput<S>, extra: Extra) => Promise<unknown>,
  ) {
    const { structured, isWrite, ...definition } = config;
    const writes = (args: ShapeOutput<S>) => (isWrite ? isWrite(args) : config.annotations.readOnlyHint !== true);
    const cb = async (args: ShapeOutput<S>, extra: Extra): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const data = await handler(args, extra);
        if (writes(args)) audit(extra, name, args, { ok: true, ms: Date.now() - started });
        return ok(data, structured);
      } catch (e) {
        if (e instanceof Declined) {
          if (writes(args)) audit(extra, name, args, { ok: false, declined: true });
          return ok({ canceled: true, reason: e.message, note: "Nothing was changed. Do not retry unless the user asks again." });
        }
        if (writes(args)) audit(extra, name, args, { ok: false, error: errorMessage(e).slice(0, 300) });
        return fail(e);
      }
    };
    return server.registerTool(name, definition as any, cb as any);
  }

  /**
   * Asks the user to confirm a destructive action through MCP elicitation, when the client supports it
   * (stdio clients such as Claude Code). Stateless HTTP cannot elicit, so there the client's own tool
   * approval is the safeguard.
   */
  async function confirm(extra: Extra, message: string): Promise<void> {
    if (!cfg.confirmDestructive) return;
    if (!server.server.getClientCapabilities()?.elicitation?.form) return;
    let result;
    try {
      result = await server.server.elicitInput(
        { mode: "form", message, requestedSchema: { type: "object", properties: {} } },
        { signal: extra.signal, relatedRequestId: extra.requestId, timeout: 10 * 60_000 },
      );
    } catch (e) {
      throw new Declined(`The confirmation was not answered (${errorMessage(e)}).`);
    }
    if (result.action !== "accept")
      throw new Declined(result.action === "decline" ? "The user declined the confirmation." : "The user dismissed the confirmation.");
  }

  /** Progress notification for long reads, when the client asked for progress. */
  function progress(extra: Extra, done: number, total?: number, message?: string) {
    const token = extra._meta?.progressToken;
    if (token === undefined) return;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } })
      .catch(() => undefined);
  }

  /** Resolves an order by ID (order_…) or by order number (display_id). */
  async function resolveOrderId(ref: string): Promise<string> {
    const r = ref.trim().replace(/^#/, "");
    if (r.startsWith("order_")) return r;
    if (/^\d+$/.test(r)) {
      const res = await medusa.get("/admin/orders", { q: r, fields: "id,display_id", limit: 50 });
      const hit = (res.orders ?? []).find((o: any) => String(o.display_id) === r);
      if (hit) return hit.id;
      throw new Error(`Order #${r} not found`);
    }
    return r;
  }

  async function getStockLocations() {
    const res = await medusa.cachedGet("/admin/stock-locations", { fields: "id,name,*address", limit: 100 });
    return (res.stock_locations ?? []) as any[];
  }

  /** The given location, or the store's only stock location. */
  async function resolveLocationId(locationId?: string): Promise<string> {
    if (locationId) return locationId;
    const locs = await getStockLocations();
    if (locs.length !== 1)
      throw new Error(
        `Specify location_id – stock locations: ${locs.map((l) => `${l.name} (${l.id})`).join(", ") || "none"}`,
      );
    return locs[0].id;
  }

  /** The given region, or the store's only region. */
  async function resolveRegionId(regionId?: string): Promise<string> {
    if (regionId) return regionId;
    const res = await medusa.cachedGet("/admin/regions", { fields: "id,name,currency_code", limit: 100 });
    const regions: any[] = res.regions ?? [];
    if (regions.length !== 1)
      throw new Error(
        `Specify region_id – regions: ${regions.map((r) => `${r.name} ${r.currency_code?.toUpperCase()} (${r.id})`).join(", ") || "none"}`,
      );
    return regions[0].id;
  }

  /** Looks up a variant by SKU. */
  async function variantIdBySku(sku: string): Promise<string> {
    const res = await medusa.get("/admin/product-variants", { q: sku, fields: "id,sku", limit: 50 });
    const hits = (res.variants ?? []).filter((v: any) => v.sku === sku);
    if (hits.length !== 1) throw new Error(`SKU ${sku}: found ${hits.length} variants, expected 1.`);
    return hits[0].id;
  }

  /** Product tag values -> tag IDs, creating tags that do not exist yet. */
  async function resolveTagIds(values: string[]): Promise<{ id: string }[]> {
    if (!values.length) return [];
    const res = await medusa.get("/admin/product-tags", { value: values, fields: "id,value", limit: 200 });
    const byValue = new Map<string, string>((res.product_tags ?? []).map((t: any) => [t.value, t.id]));
    const ids: { id: string }[] = [];
    for (const value of values) {
      let id = byValue.get(value);
      if (!id) id = (await medusa.post("/admin/product-tags", { value })).product_tag.id as string;
      ids.push({ id });
    }
    return ids;
  }

  return {
    server,
    medusa,
    cfg,
    tool,
    confirm,
    progress,
    resolveOrderId,
    getStockLocations,
    resolveLocationId,
    resolveRegionId,
    variantIdBySku,
    resolveTagIds,
  };
}

export type ToolContext = ReturnType<typeof createContext>;
