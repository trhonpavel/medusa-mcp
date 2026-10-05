import { z } from "zod";
import { DESTRUCTIVE, type ToolContext } from "./helpers.js";

/** Writes here could mint credentials or accounts, so they stay out of reach of the generic tool. */
const BLOCKED_WRITE_PREFIXES = ["/admin/api-keys", "/admin/users", "/admin/invites"];

export function registerRawTool(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm } = ctx;
  if (!cfg.rawApi) return;

  const methods = cfg.readOnly ? (["GET"] as const) : (["GET", "POST", "DELETE"] as const);

  tool(
    "medusa_request",
    {
      title: "Medusa Admin API request",
      description:
        "Calls any Medusa v2 Admin API endpoint directly – for anything the other tools do not cover " +
        "(e.g. /admin/reservations, /admin/order-edits, /admin/exchanges, /admin/tax-rates, /admin/shipping-options). " +
        "Prefer the dedicated tools when one fits. Amounts are in major units. " +
        "Use 'fields' in the query to choose fields: '+field' adds to the defaults, '*relation' expands a relation. " +
        (cfg.readOnly
          ? "Read-only mode: only GET is allowed."
          : "POST creates or updates, DELETE deletes – confirm changes with the user first. " +
            "Writes to api-keys, users and invites are blocked."),
      inputSchema: {
        method: z.enum(methods).default("GET"),
        path: z.string().describe("Path starting with /admin/, e.g. /admin/reservations"),
        query: z.record(z.string(), z.any()).optional().describe("Query parameters; nested objects become a[b]=c"),
        body: z.record(z.string(), z.any()).optional().describe("JSON body for POST"),
      },
      annotations: cfg.readOnly ? { readOnlyHint: true, openWorldHint: false } : DESTRUCTIVE,
      isWrite: (a) => a.method !== "GET",
    },
    async (a, extra) => {
      const path = a.path.trim();
      if (!/^\/admin\/[A-Za-z0-9_\-./]*$/.test(path) || path.split("/").some((s) => s === ".." || s === "."))
        throw new Error("path must start with /admin/ and contain only letters, digits, '-', '_', '.' and '/' (put parameters in 'query').");
      const method = a.method as "GET" | "POST" | "DELETE";
      if (method !== "GET" && cfg.readOnly) throw new Error("The server is in read-only mode.");
      if (method !== "GET" && BLOCKED_WRITE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)))
        throw new Error(`Writes to ${path} are blocked for safety – use the Medusa admin.`);
      if (method === "GET" && a.body) throw new Error("GET requests have no body – use 'query'.");
      if (method !== "GET") {
        const body = a.body ? JSON.stringify(a.body) : "";
        await confirm(extra, `${method} ${path}${body ? ` with ${body.length > 300 ? body.slice(0, 300) + "…" : body}` : ""}?`);
      }
      return medusa.request(method, path, { query: a.query, body: method === "POST" ? (a.body ?? {}) : undefined });
    },
  );
}
