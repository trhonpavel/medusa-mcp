# medusa-mcp

[![AgentHub 已收录：Medusa](https://myagenthub.cn/badge/io.github.trhonpavel/medusa-mcp)](https://myagenthub.cn/p/io.github.trhonpavel/medusa-mcp)
🇨🇿 [Česky](README.cs.md)

An [MCP](https://modelcontextprotocol.io) server for the **Medusa v2 Admin API**. It gives Claude (or any MCP client) access to orders, customers, products and inventory, computes sales reports, and manages the store – fulfillment, payments and refunds, returns, draft orders, products and variants, catalog, promotions and price lists – with guard rails on destructive actions.

It runs in two modes:

- **stdio** – locally for Claude Desktop, Claude Code and other MCP clients
- **Streamable HTTP + OAuth 2.1** – as a remote connector for Claude (web, desktop, mobile) and ChatGPT

It is listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.trhonpavel/medusa-mcp`, and also ships as a **Claude Code / Cowork plugin** with skills and as a one-click **Claude Desktop extension** (`.mcpb`).

## Tools

48 tools that cover day-to-day store management. Anything else is reachable through `medusa_request`.

**Read and report**

| Tool | What it does |
|---|---|
| `get_store_info` | regions and currencies, sales channels, stock locations, shipping options and profiles, return and refund reasons |
| `list_orders` / `get_order` | orders by full-text, date range, customer or status; full detail by ID or order number (`1042`, `#1042`) including payments, refunds and returns |
| `list_customers` / `get_customer` | customers (also by group), order history, total spent |
| `list_customer_groups` | customer groups |
| `list_products` / `get_product` | products by status, collection, category or tag; variants, options, prices, inventory items |
| `list_catalog` | categories (tree), collections, tags, product types |
| `list_inventory` | stock per location, `low_stock_threshold` to find what's running out |
| `list_promotions` | discount codes with value, conditions, usage and validity |
| `list_price_lists` | sales and customer-group price lists, with their prices |
| `sales_report` | revenue, AOV, units, unique customers, day/week/month series, top products |

**Write** (not registered with `MEDUSA_READ_ONLY=true`)

| Area | Tools |
|---|---|
| Fulfillment | `create_fulfillment` (defaults: all remaining items, the only stock location), `create_shipment` (tracking number), `mark_delivered`, `cancel_fulfillment` |
| Orders | `update_order` (email, addresses, metadata), `complete_order`, `cancel_order` |
| Payments | `mark_order_paid` (bank transfer, cash on delivery), `capture_payment`, `refund_payment` (checks the refundable amount) |
| Returns | `create_return` (defaults to every shipped item), `receive_return` (puts goods back in stock) |
| Draft orders | `create_draft_order` (items by variant or SKU, custom prices, shipping), `convert_draft_order` |
| Products | `create_product` (simple or with options and variants, initial stock, defaults for sales channel and shipping profile), `update_product`, `delete_product` (requires `confirm_title`) |
| Variants | `create_variant` (adds new option values automatically), `update_variant`, `delete_variant` (requires `confirm`), `set_variant_price` (keeps all other prices) |
| Catalog | `save_category`, `delete_category`, `save_collection`, `delete_collection` (create or update, add/remove products) |
| Inventory | `set_stock_level` (absolute or `adjust_by: +10`, adds the item to a new location) |
| Customers | `save_customer` (create/update, address, groups), `save_customer_group`, `delete_customer_group` |
| Promotions | `create_promotion` (percentage, fixed or free shipping; products, categories, collections, customer groups; dates and usage limit), `update_promotion`, `delete_promotion` |
| Price lists | `save_price_list` (sales and B2B prices, upserts prices by variant or SKU), `delete_price_list` |

**Generic**

| Tool | What it does |
|---|---|
| `medusa_request` | any Admin API endpoint (`GET`, `POST`, `DELETE` under `/admin/`) for things without a dedicated tool – reservations, order edits, exchanges, tax rates… Read-only mode allows `GET` only; writes to `api-keys`, `users` and `invites` are always blocked. Turn it off with `MEDUSA_RAW_API=false`. |

Amounts are in major currency units (Medusa v2 does not store minor units). Plain dates (`2026-09-01`) are interpreted in `REPORT_TIMEZONE` (default `UTC`).
Destructive tools (cancel, delete, refund, capture, `medusa_request`) carry `destructiveHint`, so clients ask before running them.

## 1. Create a Medusa API key

In the Medusa Admin go to **Settings → Developer → Secret API Keys → Create**. The key (`sk_…`) acts with the permissions of the user who created it, so consider a dedicated admin user that you can revoke independently.

## 2. Local use (stdio)

### Claude Code / Cowork plugin

```bash
claude plugin marketplace add trhonpavel/medusa-mcp
claude plugin install medusa@medusa-mcp
```

Claude Code asks for the backend URL and the API key when you enable the plugin (the key goes to the system keychain). Write tools stay off until you turn off **Read-only** in `/config`. The plugin adds two skills:

- `store-briefing` – yesterday's and month-to-date sales, paid orders waiting to ship, low stock
- `fulfill-orders` – fulfill paid orders and add tracking numbers, after you confirm the list

### Claude Desktop extension

Download `medusa-mcp-<version>.mcpb` from the [latest release](https://github.com/trhonpavel/medusa-mcp/releases/latest) and open it, or drag it to **Settings → Extensions**. Claude Desktop asks for the same settings and runs the server with its bundled Node.js. Build it yourself with `npm run build:mcpb`.

### Manual configuration

Claude Desktop – `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "medusa": {
      "command": "npx",
      "args": ["-y", "medusa-mcp", "stdio"],
      "env": {
        "MEDUSA_BACKEND_URL": "https://api.example.com",
        "MEDUSA_API_KEY": "sk_...",
        "MEDUSA_READ_ONLY": "true"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add medusa \
  -e MEDUSA_BACKEND_URL=https://api.example.com -e MEDUSA_API_KEY=sk_... \
  -- npx -y medusa-mcp stdio
```

## 3. Remote connector (HTTP + OAuth)

```bash
docker run -d --name medusa-mcp -p 127.0.0.1:3000:3000 -v medusa-mcp-data:/data \
  -e MEDUSA_BACKEND_URL=https://api.example.com \
  -e MEDUSA_API_KEY=sk_... \
  -e PUBLIC_URL=https://mcp.example.com \
  -e OWNER_PASSWORD="$(openssl rand -base64 24)" \
  ghcr.io/trhonpavel/medusa-mcp:latest
```

Or clone the repo, copy `.env.example` to `.env` and run `docker compose up -d --build`.

The server listens on `127.0.0.1:3000`; expose it through a reverse proxy with TLS. Claude connects to remote connectors from Anthropic's servers, so the endpoint must be **publicly reachable over HTTPS**. Caddy example:

```
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then add a custom connector in Claude with the URL **`https://mcp.example.com/mcp`**. Claude registers itself (Dynamic Client Registration), opens the consent page, you enter `OWNER_PASSWORD` and click Allow.

### ChatGPT

In ChatGPT turn on **developer mode** in the settings, then create an app (connector) with the MCP server URL **`https://mcp.example.com/mcp`** and OAuth authentication. ChatGPT registers itself the same way and redirects to `chatgpt.com`, which is in the default `ALLOWED_REDIRECT_HOSTS`. The server returns the RFC 9207 `iss` parameter, so ChatGPT uses its stable callback URL.

### Claude Code

Claude Code can use the same OAuth flow, or a static token if you set `MCP_STATIC_TOKEN`:

```bash
claude mcp add --transport http medusa https://mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_STATIC_TOKEN>"
```

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MEDUSA_BACKEND_URL` | yes | | Medusa backend URL |
| `MEDUSA_API_KEY` | yes | | Secret API key (`sk_…`) |
| `MEDUSA_READ_ONLY` | | `false` | Register read and report tools only |
| `MEDUSA_RAW_API` | | `true` | Register the generic `medusa_request` tool (GET only when read-only) |
| `REPORT_TIMEZONE` | | `UTC` | IANA timezone for date filters and report buckets |
| `MEDUSA_TIMEOUT_MS` | | `20000` | Timeout for Medusa requests |
| `PUBLIC_URL` | HTTP | | Public HTTPS origin of this server (without `/mcp`) |
| `OWNER_PASSWORD` | HTTP | | Password required on the consent page |
| `MCP_STATIC_TOKEN` | | | Optional static bearer token |
| `ALLOWED_REDIRECT_HOSTS` | | `claude.ai,claude.com,chatgpt.com,localhost,127.0.0.1` | Hosts OAuth clients may use as redirect targets |
| `TRUST_PROXY` | | `1` | Express `trust proxy` – number of proxies in front |
| `PORT` / `HOST` | | `3000` / `0.0.0.0` | Listen address |
| `DATA_DIR` | | `./data` | Where OAuth clients and token hashes are stored |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | | `3600` / `2592000` | Token lifetimes in seconds |

### Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP (stateless), requires a bearer token |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1 (DCR, PKCE S256) |
| `POST /oauth/login` | consent form (rate limited: 10 attempts / 15 min / IP) |
| `GET /healthz` | health check |

## Security model

- The Medusa API key never leaves the server. Clients get their own short-lived tokens (1 h access, 30-day refresh with rotation).
- Only SHA-256 hashes of tokens are stored, in `DATA_DIR/oauth-state.json` (mode 600). Delete the file to sign out every client.
- Dynamic Client Registration only accepts redirect URIs on `ALLOWED_REDIRECT_HOSTS`, so an arbitrary app cannot register its own callback and phish a token.
- Authorization codes are single-use, expire after 5 minutes, and PKCE S256 is mandatory.
- The consent page sends `Content-Security-Policy: default-src 'none'` and `X-Frame-Options: DENY`, and compares the password in constant time.
- Write tools are not marked `readOnlyHint`, and tools that cancel, delete or move money carry `destructiveHint`, so clients like Claude ask for approval before running them.
- `medusa_request` only reaches `/admin/…` paths, never writes to `api-keys`, `users` or `invites` (so a prompt injection cannot mint new credentials), and can be disabled with `MEDUSA_RAW_API=false`.
- Set `TRUST_PROXY` to the number of reverse proxies in front of the server, otherwise rate limiting only sees the proxy's IP.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Development

```bash
npm ci
npm test        # build + tests against a mock Medusa (tools and the full OAuth flow)
npm run smoke   # read-only check against a real Medusa – prints response shapes only, no data
npm run dev     # HTTP mode via tsx
```

`npm run smoke` needs `MEDUSA_BACKEND_URL` and `MEDUSA_API_KEY`. Its output contains only keys and types, so it is safe to paste into an issue.

## License

[MIT](LICENSE)
