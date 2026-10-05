import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { HttpConfig } from "./config.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

type StoredToken = { clientId: string; scopes: string[]; expiresAt: number; resource?: string };
type State = {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, StoredToken>; // key = sha256(token)
  refresh: Record<string, StoredToken>;
};

type PendingAuth = { clientId: string; params: AuthorizationParams; clientName?: string; createdAt: number };
type AuthCode = { clientId: string; params: AuthorizationParams; expiresAt: number };

/** Simple persistent store (JSON file) so clients and tokens survive restarts. */
class FileStore {
  private path: string;
  state: State = { clients: {}, access: {}, refresh: {} };
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "oauth-state.json");
    if (existsSync(this.path)) {
      try {
        this.state = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        console.error("[medusa-mcp] oauth-state.json is corrupted, starting fresh");
      }
    }
    this.gc();
  }
  gc() {
    const t = now();
    for (const m of [this.state.access, this.state.refresh])
      for (const [k, v] of Object.entries(m)) if (v.expiresAt < t) delete m[k];
  }
  save() {
    this.gc();
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class OwnerPasswordOAuthProvider implements OAuthServerProvider {
  private store: FileStore;
  private pending = new Map<string, PendingAuth>();
  private codes = new Map<string, AuthCode>();
  private passwordHash: Buffer;

  constructor(
    private cfg: HttpConfig,
    /** Authorization server issuer, exactly as published in the metadata. */
    readonly issuer: string,
  ) {
    this.store = new FileStore(cfg.dataDir);
    this.passwordHash = createHash("sha256").update(cfg.ownerPassword.trim()).digest();
    setInterval(() => {
      const t = Date.now();
      for (const [k, v] of this.pending) if (t - v.createdAt > 10 * 60_000) this.pending.delete(k);
      for (const [k, v] of this.codes) if (v.expiresAt < now()) this.codes.delete(k);
    }, 60_000).unref();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const s = this.store;
    const allowed = this.cfg.allowedRedirectHosts;
    return {
      getClient: (id) => s.state.clients[id],
      registerClient: (client) => {
        for (const uri of client.redirect_uris) {
          let host: string;
          try {
            host = new URL(uri).hostname.toLowerCase();
          } catch {
            throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
          }
          if (!allowed.some((h) => host === h || host.endsWith(`.${h}`)))
            throw new InvalidClientMetadataError(`redirect_uri host ${host} is not allowed`);
        }
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: now(),
        };
        s.state.clients[full.client_id] = full;
        s.save();
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = token();
    this.pending.set(id, { clientId: client.client_id, params, clientName: client.client_name, createdAt: Date.now() });
    this.renderLogin(res, id);
  }

  /** Sends the consent page for a pending authorization, optionally with an error. */
  renderLogin(res: Response, pendingId: string, error?: string) {
    const p = this.pending.get(pendingId);
    // Browsers apply form-action to the redirect that follows the form post, so the
    // client's redirect origin has to be allowed next to 'self'.
    const formAction = p ? `'self' ${new URL(p.params.redirectUri).origin}` : "'self'";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`);
    res.setHeader("X-Frame-Options", "DENY");
    res.type("html").send(loginPage(pendingId, p?.clientName, p?.params.redirectUri, error));
  }

  /** Called from POST /oauth/login. Returns a redirect URL or an error message. */
  completeLogin(pendingId: string, password: string, approve: boolean): { redirect?: string; error?: string } {
    const p = this.pending.get(pendingId);
    if (!p) return { error: "This request has expired. Please start connecting again." };
    const url = new URL(withIssuer(p.params.redirectUri, this.issuer));
    if (p.params.state) url.searchParams.set("state", p.params.state);
    if (!approve) {
      this.pending.delete(pendingId);
      url.searchParams.set("error", "access_denied");
      return { redirect: url.toString() };
    }
    const given = createHash("sha256").update(password.trim()).digest();
    if (!timingSafeEqual(given, this.passwordHash)) {
      console.error(
        `[medusa-mcp] wrong owner password for client "${p.clientName ?? p.clientId}" (${password.trim().length} characters)`,
      );
      return { error: "Wrong password." };
    }
    this.pending.delete(pendingId);
    const code = token();
    this.codes.set(code, { clientId: p.clientId, params: p.params, expiresAt: now() + 300 });
    url.searchParams.set("code", code);
    return { redirect: url.toString() };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return c.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!c || c.clientId !== client.client_id || c.expiresAt < now())
      throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issue(client.client_id, c.params.scopes ?? [], c.params.resource?.href);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const t = this.store.state.refresh[key];
    if (!t || t.clientId !== client.client_id || t.expiresAt < now())
      throw new InvalidGrantError("Invalid refresh token");
    delete this.store.state.refresh[key]; // rotace
    return this.issue(client.client_id, t.scopes, t.resource);
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = token();
    const refresh = token();
    const t = now();
    this.store.state.access[sha256(access)] = {
      clientId,
      scopes,
      resource,
      expiresAt: t + this.cfg.accessTokenTtlSec,
    };
    this.store.state.refresh[sha256(refresh)] = {
      clientId,
      scopes,
      resource,
      expiresAt: t + this.cfg.refreshTokenTtlSec,
    };
    this.store.save();
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: this.cfg.accessTokenTtlSec,
      refresh_token: refresh,
      scope: scopes.join(" ") || undefined,
    };
  }

  async verifyAccessToken(tok: string): Promise<AuthInfo> {
    if (this.cfg.staticToken) {
      const a = Buffer.from(sha256(tok));
      const b = Buffer.from(sha256(this.cfg.staticToken));
      if (timingSafeEqual(a, b)) return { token: tok, clientId: "static", scopes: [], expiresAt: now() + 3600 };
    }
    const t = this.store.state.access[sha256(tok)];
    if (!t || t.expiresAt < now()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token: tok,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: t.expiresAt,
      resource: t.resource ? new URL(t.resource) : undefined,
      // Shown in the audit log next to write actions
      extra: { clientName: this.store.state.clients[t.clientId]?.client_name },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, req: { token: string }): Promise<void> {
    const k = sha256(req.token);
    for (const m of [this.store.state.access, this.store.state.refresh])
      if (m[k]?.clientId === client.client_id) delete m[k];
    this.store.save();
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Adds the RFC 9207 `iss` parameter to an authorization response redirect. */
export function withIssuer(redirectUrl: string, issuer: string): string {
  const url = new URL(redirectUrl);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export function loginPage(pendingId: string, clientName?: string, redirectUri?: string, error?: string) {
  const host = redirectUri ? new URL(redirectUri).host : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Medusa MCP – authorize</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1b18;--muted:#6b665e;--line:#e3dfd7;--accent:#2f5d50;--err:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#151412;--card:#1f1d1a;--fg:#ece8e1;--muted:#a39d93;--line:#34312c;--accent:#7fb8a6;--err:#e88}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:var(--muted);font-size:14px}
code{font-size:13px}label{display:block;font-size:14px;margin-bottom:6px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font-size:16px}
.row{display:flex;flex-direction:row-reverse;gap:10px;margin-top:18px}button{flex:1;padding:11px;border-radius:9px;border:1px solid var(--line);font-size:15px;cursor:pointer;background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}@media (prefers-color-scheme:dark){button.primary{color:#111}}
.err{color:var(--err);font-size:14px;margin:12px 0 0}
</style></head><body><main>
<h1>Connect your store</h1>
<p><strong>${esc(clientName ?? "A client")}</strong> is requesting access to the Medusa Admin API.<br>You will be redirected to <code>${esc(host)}</code>.</p>
<form method="post" action="/oauth/login">
<input type="hidden" name="pending" value="${esc(pendingId)}">
<label for="pw">Owner password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<div class="row"><button class="primary" name="action" value="approve">Allow</button><button name="action" value="deny">Deny</button></div>
</form></main></body></html>`;
}
