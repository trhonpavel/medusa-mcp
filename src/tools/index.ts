import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MedusaClient } from "../medusa.js";
import type { MedusaConfig, Toolset } from "../config.js";
import { createContext, type ToolContext } from "./helpers.js";
import { registerStoreTools } from "./store.js";
import { registerOrderTools } from "./orders.js";
import { registerCustomerTools } from "./customers.js";
import { registerProductTools } from "./products.js";
import { registerCatalogTools } from "./catalog.js";
import { registerInventoryTools } from "./inventory.js";
import { registerPricingTools } from "./pricing.js";
import { registerPromotionTools } from "./promotions.js";
import { registerReportTools } from "./reports.js";
import { registerBulkTools } from "./bulk.js";
import { registerRawTool } from "./raw.js";

const MODULES: Record<Toolset, (ctx: ToolContext) => void> = {
  orders: registerOrderTools,
  customers: registerCustomerTools,
  products: registerProductTools,
  catalog: registerCatalogTools,
  inventory: registerInventoryTools,
  pricing: registerPricingTools,
  promotions: registerPromotionTools,
  reports: registerReportTools,
  bulk: registerBulkTools,
  raw: registerRawTool,
};

/** Each module registers its read tools and, unless the server is read-only, its write tools. */
export function registerTools(server: McpServer, medusa: MedusaClient, cfg: MedusaConfig): ToolContext {
  const ctx = createContext(server, medusa, cfg);
  registerStoreTools(ctx);
  for (const [name, register] of Object.entries(MODULES) as [Toolset, (ctx: ToolContext) => void][])
    if (!cfg.toolsets || cfg.toolsets.has(name)) register(ctx);
  return ctx;
}
