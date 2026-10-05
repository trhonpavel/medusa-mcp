import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MedusaConfig } from "./config.js";
import type { MedusaClient } from "./medusa.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { registerApps } from "./apps.js";

function instructions(cfg: MedusaConfig) {
  const tz = process.env.REPORT_TIMEZONE || "UTC";
  return [
    "Tools for managing a Medusa v2 store.",
    "Start with get_store_info to learn IDs (regions, stock locations, shipping options, return and refund reasons).",
    `Amounts are in major currency units (49.99 = 49.99 EUR). Plain dates (YYYY-MM-DD) are in the store timezone ${tz}.`,
    "Orders can be referenced by their number (1042).",
    "Ask the user for explicit confirmation before canceling, refunding, deleting or making bulk changes.",
    "bulk_* tools and edit_order preview with dry_run (the default): show the preview, then repeat with dry_run false once the user agrees.",
    "For analysis use sales_report (with period comparison), customer_report and inventory_forecast (restocking).",
    "Use medusa_request only when no dedicated tool fits.",
    cfg.readOnly ? "The server is running in read-only mode." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function createServer(medusa: MedusaClient, cfg: MedusaConfig): McpServer {
  const server = new McpServer({ name: "medusa-mcp", version: "0.4.0" }, { instructions: instructions(cfg) });
  const ctx = registerTools(server, medusa, cfg);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  registerApps(server);
  return server;
}
