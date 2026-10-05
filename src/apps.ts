import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** MIME type of MCP Apps views (https://modelcontextprotocol.io/extensions/apps). */
export const APP_MIME = "text/html;profile=mcp-app";

const VIEWS = [
  {
    name: "sales-dashboard",
    uri: "ui://medusa/sales-dashboard.html",
    title: "Sales dashboard",
    description: "Interactive sales dashboard shown with sales_report results.",
  },
  {
    name: "restock-plan",
    uri: "ui://medusa/restock.html",
    title: "Restock plan",
    description: "Interactive restock table shown with inventory_forecast results.",
  },
];

/** Built views live next to this file in dist/apps (scripts/build-ui.mjs inlines the MCP Apps runtime). */
function loadView(uri: string): string {
  const file = new URL(`./apps/${uri.split("/").pop()}`, import.meta.url);
  if (!existsSync(file)) throw new Error(`UI view ${uri} is missing – run npm run build.`);
  return readFileSync(file, "utf8");
}

/** Registers the HTML views that tools link to through `_meta.ui.resourceUri`. */
export function registerApps(server: McpServer) {
  const cache = new Map<string, string>();
  for (const view of VIEWS) {
    server.registerResource(
      view.name,
      view.uri,
      { title: view.title, description: view.description, mimeType: APP_MIME },
      async () => {
        if (!cache.has(view.uri)) cache.set(view.uri, loadView(view.uri));
        return {
          contents: [
            {
              uri: view.uri,
              mimeType: APP_MIME,
              text: cache.get(view.uri)!,
              // No external requests: everything is inlined, so the default (empty) CSP is enough
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        };
      },
    );
  }
}
