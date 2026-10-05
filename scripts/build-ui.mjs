// Builds the MCP Apps views: copies src/apps/*.html to dist/apps/ and inlines the ext-apps runtime,
// so every view is a single self-contained HTML file (hosts render it in a sandboxed iframe).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "src", "apps");
const out = join(root, "dist", "apps");
const MARKER = "/*__MCP_APPS_RUNTIME__*/";

// The bundle is an ES module ending in `export{a as App,…}`; turn the exports into a local object
// so the view's own code in the same <script type="module"> can use them.
const require = createRequire(import.meta.url);
let runtime = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
const exp = runtime.lastIndexOf("export{");
if (exp < 0) throw new Error("Unexpected ext-apps bundle format (no export list)");
const list = runtime.slice(exp + "export{".length, runtime.indexOf("}", exp));
const entries = list.split(",").map((part) => {
  const [local, exported] = part.trim().split(/\s+as\s+/);
  return `${JSON.stringify(exported ?? local)}:${local}`;
});
runtime = `${runtime.slice(0, exp)}const McpApps={${entries.join(",")}};${runtime.slice(runtime.indexOf("}", exp) + 1)}`;
if (runtime.includes("</script")) runtime = runtime.replaceAll("</script", "<\\/script");

mkdirSync(out, { recursive: true });
for (const file of readdirSync(src).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(src, file), "utf8");
  if (!html.includes(MARKER)) throw new Error(`${file} has no ${MARKER} marker`);
  // A function replacement, so `$&` and friends in the bundle are not interpreted
  writeFileSync(join(out, file), html.replace(MARKER, () => runtime));
  console.log(`ui: dist/apps/${file}`);
}
