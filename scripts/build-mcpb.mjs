// Builds build/medusa-mcp-<version>.mcpb for Claude Desktop.
// The manifest template in mcpb/manifest.json gets the package version and the tool list
// read from the built server, so neither can drift from the code.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { MedusaClient } from "../dist/medusa.js";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "build", "mcpb");
const out = join(root, "build", `medusa-mcp-${pkg.version}.mcpb`);

// Tool list from the server with write tools enabled (no requests are made)
const cfg = {
  backendUrl: "https://example.invalid",
  apiKey: "sk_build",
  readOnly: false,
  timeoutMs: 1000,
  rawApi: true,
  toolsets: null,
  confirmDestructive: true,
};
const server = createServer(new MedusaClient(cfg), cfg);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "build-mcpb", version: pkg.version });
await client.connect(b);
const { tools } = await client.listTools();
await client.close();

const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
manifest.version = pkg.version;
manifest.tools = tools.map((t) => ({ name: t.name, description: t.description }));

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["dist", "package.json", "package-lock.json", "LICENSE", "README.md"])
  cpSync(join(root, f), join(stage, f), { recursive: true });
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });

const mcpb = ["-y", "@anthropic-ai/mcpb@2"];
execFileSync("npx", [...mcpb, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync("npx", [...mcpb, "pack", stage, out], { stdio: "inherit" });
console.log(`\n${out}`);
