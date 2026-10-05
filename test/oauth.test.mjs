import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockMedusa, MOCK_KEY } from "./mock-medusa.mjs";

const PUBLIC_URL = "https://mcp.example.com";
const PASSWORD = "correct-horse-battery-staple";
const STATIC = "static-token-for-tests";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let mock, proc, BASE, dataDir;
let stderr = "";

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

before(async () => {
  mock = await startMockMedusa();
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "medusa-mcp-"));
  proc = spawn(process.execPath, ["dist/index.js", "http"], {
    env: {
      ...process.env,
      MEDUSA_BACKEND_URL: mock.url,
      MEDUSA_API_KEY: MOCK_KEY,
      PUBLIC_URL,
      OWNER_PASSWORD: PASSWORD,
      MCP_STATIC_TOKEN: STATIC,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => {
  proc?.kill();
  mock?.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const form = (o) => ({
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o),
});
const json = (o) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

async function mcp(token, body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, headers: res.headers, data: line ? JSON.parse(line.slice(5)) : undefined };
}

async function register(redirect_uris) {
  return fetch(
    `${BASE}/register`,
    json({ redirect_uris, client_name: "Test", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  );
}

async function authorize(clientId) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: `${PUBLIC_URL}/mcp`,
  }))
    u.searchParams.set(k, v);
  const page = await (await fetch(u)).text();
  const pending = page.match(/name="pending" value="([^"]+)"/)?.[1];
  return { verifier, pending };
}

test("unauthenticated /mcp returns 401 with resource metadata", async () => {
  const r = await mcp(undefined, {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("discovery metadata", async () => {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${PUBLIC_URL}/mcp`);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.ok(as.registration_endpoint);
  assert.ok(as.code_challenge_methods_supported.includes("S256"));
  assert.equal(as.issuer, `${PUBLIC_URL}/`);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
});

test("DCR accepts ChatGPT redirect URIs", async () => {
  const r = await register([
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/abc123",
  ]);
  assert.equal(r.status, 201);
});

test("SDK error redirects from /authorize carry iss", async () => {
  const client = await (await register([REDIRECT])).json();
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: "s" }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  assert.ok(loc.searchParams.get("error"), "missing code_challenge is reported");
  assert.equal(loc.searchParams.get("iss"), `${PUBLIC_URL}/`);
});

test("DCR rejects redirect hosts outside the allowlist", async () => {
  assert.equal((await register(["https://evil.example.net/cb"])).status, 400);
  assert.equal((await register(["https://claude.ai.evil.net/cb"])).status, 400);
});

test("full authorization code + PKCE flow, refresh rotation, revocation of reuse", async () => {
  const client = await (await register([REDIRECT])).json();
  assert.ok(client.client_id);

  const { verifier, pending } = await authorize(client.client_id);
  assert.ok(pending, "consent page rendered");

  assert.equal((await fetch(`${BASE}/oauth/login`, form({ pending, password: "nope", action: "approve" }))).status, 401);

  const ok = await fetch(`${BASE}/oauth/login`, form({ pending, password: PASSWORD, action: "approve" }));
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get("location"));
  assert.equal(loc.origin, "https://claude.ai");
  assert.equal(loc.searchParams.get("state"), "st4te");
  assert.equal(loc.searchParams.get("iss"), `${PUBLIC_URL}/`, "RFC 9207 issuer");
  const code = loc.searchParams.get("code");

  const tokenReq = (params) => fetch(`${BASE}/token`, form(params));
  const base = { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT };
  assert.equal((await tokenReq({ ...base, code_verifier: "x".repeat(43) })).status, 400, "wrong PKCE verifier");
  const tok = await (await tokenReq({ ...base, code_verifier: verifier })).json();
  assert.ok(tok.access_token && tok.refresh_token);
  assert.equal((await tokenReq({ ...base, code_verifier: verifier })).status, 400, "code is single-use");

  const init = await mcp(tok.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(init.data.result.serverInfo.name, "medusa-mcp");
  const call = await mcp(tok.access_token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_store_info", arguments: {} },
  });
  assert.match(call.data.result.content[0].text, /sloc_1/);

  const refresh = { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id };
  const tok2 = await (await tokenReq(refresh)).json();
  assert.ok(tok2.access_token);
  assert.notEqual(tok2.refresh_token, tok.refresh_token);
  assert.equal((await tokenReq(refresh)).status, 400, "old refresh token is invalidated");
});

test("consent page lets the browser follow the redirect and defaults to Allow", async () => {
  const client = await (await register([REDIRECT])).json();
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  }))
    u.searchParams.set(k, v);
  const page = await fetch(u);
  assert.match(page.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai(;|$)/);
  const html = await page.text();
  assert.ok(html.indexOf('value="approve"') < html.indexOf('value="deny"'), "Enter submits Allow");

  const pending = html.match(/name="pending" value="([^"]+)"/)[1];
  const wrong = await fetch(`${BASE}/oauth/login`, form({ pending, password: "nope", action: "approve" }));
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai/);
  assert.match(await wrong.text(), /<strong>Test<\/strong>/, "client name kept after a wrong password");

  const ok = await fetch(`${BASE}/oauth/login`, form({ pending, password: `  ${PASSWORD}\n`, action: "approve" }));
  assert.equal(ok.status, 302, "surrounding whitespace is ignored");
});

test("deny redirects with access_denied", async () => {
  const client = await (await register([REDIRECT])).json();
  const { pending } = await authorize(client.client_id);
  const r = await fetch(`${BASE}/oauth/login`, form({ pending, action: "deny" }));
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("iss"), `${PUBLIC_URL}/`);
});

test("static token works, random token does not", async () => {
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await mcp(STATIC, list)).status, 200);
  assert.equal((await mcp("random", list)).status, 401);
});

test("the remote connector serves tools, progress, views, prompts and audits writes", async () => {
  const client = new Client({ name: "remote-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${STATIC}` } } }),
  );
  const { tools } = await client.listTools();
  assert.equal(tools.length, 55);
  const progress = [];
  const report = await client.callTool(
    { name: "sales_report", arguments: { from: "2026-09-01", to: "2026-09-30" } },
    undefined,
    { onprogress: (p) => progress.push(p) },
  );
  assert.equal(report.isError, undefined);
  assert.ok(progress.length >= 1, "progress notifications arrive over SSE");
  const view = await client.readResource({ uri: "ui://medusa/sales-dashboard.html" });
  assert.equal(view.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal((await client.listPrompts()).prompts.length, 7);
  // Stateless HTTP cannot elicit: the write goes through and is audited with the client identity
  const r = await client.callTool({ name: "update_order", arguments: { order: "1001", metadata: { via: "http" } } });
  assert.equal(r.isError, undefined, r.content[0].text);
  await client.close();
  await new Promise((res) => setTimeout(res, 100));
  assert.match(stderr, /\[audit\] \{[^\n]*"tool":"update_order","client":"static"[^\n]*"ok":true/);
});
