# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.4.0] – 2026-10-05

### Added

- **Interactive views (MCP Apps)**: `sales_report` shows a sales dashboard and `inventory_forecast` a restock planner inline in Claude, ChatGPT and other MCP Apps clients. They follow the client's theme and language (Czech or English), switch periods or recalculate by calling the tools, and are self-contained HTML.
- `customer_report` – new vs returning customers, repeat purchase rate, top customers and lapsed customers.
- `inventory_forecast` – sales velocity vs stock: days of cover, reorder status and suggested quantities, slow movers.
- `sales_report` compares with the previous period or the same period last year, subtracts refunds (`net_revenue`), and breaks down countries, discount codes, variants and sales channels.
- Bulk tools with a dry-run preview: `bulk_update_prices` (percent, amount or fixed price, price endings like 199 or 19.99), `bulk_set_stock`, `bulk_update_products`.
- `edit_order` – add, change or remove items of an existing order, with a preview of the new total and what the customer owes or gets back.
- `add_product_images` – images from URLs, copied to the shop's storage; private and local addresses are refused.
- Prompts: `store_briefing`, `fulfill_orders`, `restock_plan`, `handle_return`, `customer_overview`, `monthly_report`, `plan_promotion`, with argument completion.
- Resources: `medusa://store`, `medusa://orders/{order}`, `medusa://products/{handle}`, `medusa://customers/{email}`, with completion.
- Confirmation dialogs through MCP elicitation before destructive actions, in clients that support it (`MEDUSA_CONFIRM_DESTRUCTIVE`).
- Audit log: every write tool call is logged to stderr with the OAuth client name, and to `AUDIT_LOG` when set.
- `MEDUSA_TOOLSETS` registers only selected tool groups.
- Progress notifications while large reports load.
- `get_order` shows discount codes, paid, refunded and outstanding amounts; `get_product` accepts a handle and `get_customer` an e-mail.

### Changed

- Tool results leave out `null` fields, which saves tokens on Medusa objects.
- GET requests are retried on network errors and 429/502/503/504; store settings (regions, locations, channels) are cached for a minute.

## [0.3.0] – 2026-10-03

### Added

- 31 new tools – the server now covers day-to-day store management:
  - Fulfillment: `mark_delivered`, `cancel_fulfillment`.
  - Orders and payments: `update_order`, `mark_order_paid`, `capture_payment`, `refund_payment`.
  - Returns: `create_return`, `receive_return`.
  - Draft orders: `create_draft_order`, `convert_draft_order`.
  - Products: `create_product` (simple or with options and variants, initial stock), `create_variant`, `update_variant`, `delete_variant`.
  - Catalog: `list_catalog`, `save_category`, `delete_category`, `save_collection`, `delete_collection`.
  - Customers: `save_customer`, `list_customer_groups`, `save_customer_group`, `delete_customer_group`.
  - Promotions: `list_promotions`, `create_promotion`, `update_promotion`, `delete_promotion`.
  - Price lists: `list_price_lists`, `save_price_list`, `delete_price_list`.
  - `medusa_request` for any other Admin API endpoint (GET only in read-only mode, never writes to `api-keys`, `users` or `invites`; disable with `MEDUSA_RAW_API=false`).
- `get_order` shows individual payments with captures, refunds and the refundable amount, plus returns.
- `get_store_info` lists shipping options and profiles, return reasons and refund reasons.
- `get_product` shows option values per variant, images, sales channels and the shipping profile.
- `update_product` can change images, collection, categories, tags, sales channels, shipping profile, discountable and weight.
- `set_stock_level` adds the item to a stock location where it is not stocked yet.
- `list_customers` filters by customer group, `list_products` by tag.
- `mark_order_paid` creates a payment collection for the outstanding amount when the order has none (e.g. a converted draft order).
- Fulfillment tools report the order's fulfillment status after the change.
- `delete_variant` removes the variant's unreserved inventory item, and `delete_promotion` removes the campaign `create_promotion` made for its dates.

### Changed

- Tools are split into modules under `src/tools/`.

## [0.2.2] – 2026-10-01

### Added

- Listing in the official MCP Registry as `io.github.trhonpavel/medusa-mcp` (`server.json`, `mcpName`); releases publish it via GitHub OIDC.

### Changed

- npm releases use trusted publishing only (no npm token).

## [0.2.1] – 2026-10-01

### Fixed

- The consent page's `Content-Security-Policy` allowed form submissions only to the server itself, so Chrome blocked the redirect back to the client after a correct password. It now also allows the client's redirect origin.
- Pressing Enter in the password field submitted **Deny**; **Allow** is now the default button.
- The owner password ignores surrounding whitespace, and a wrong password is logged with the client name and the length of what was entered (never the value).
- After a wrong password the consent page kept no client name or redirect host.

## [0.2.0] – 2026-10-01

### Added

- `delete_product` with a `confirm_title` safeguard; also removes the variants' unreserved inventory items.
- ChatGPT as a remote connector: `chatgpt.com` is in the default `ALLOWED_REDIRECT_HOSTS`, and authorization responses carry the RFC 9207 `iss` parameter (advertised as `authorization_response_iss_parameter_supported`).
- Claude Code / Cowork plugin (`.claude-plugin/`) with `store-briefing` and `fulfill-orders` skills; the repository is its own plugin marketplace.
- Claude Desktop extension: `npm run build:mcpb` builds `medusa-mcp-<version>.mcpb`, and releases attach it.

## [0.1.0] – 2026-10-01

### Added

- Read tools: `get_store_info`, `list_orders`, `get_order`, `list_customers`, `get_customer`, `list_products`, `get_product`, `list_inventory`.
- `sales_report` with per-currency totals, time series and top products.
- Write tools: `create_fulfillment`, `create_shipment`, `complete_order`, `cancel_order`, `update_product`, `set_variant_price`, `set_stock_level`.
- `MEDUSA_READ_ONLY` mode.
- stdio transport.
- Streamable HTTP transport with a built-in OAuth 2.1 authorization server (DCR with redirect allowlist, PKCE S256, refresh token rotation, owner-password consent page).
- Docker image and `docker-compose.yml`.
- Test suite against a mock Medusa and a read-only `npm run smoke` check for real backends.

### Fixed before release (verified against a real Medusa 2.13 backend)

- `get_order` returned no `display_id`, totals, `email`, `currency_code` or line item totals: a single plain field in `fields` makes Medusa replace its default fields, so every field is now prefixed with `+` or `*`. The mock mirrors this rule.
- `sales_report` adds `items_total` (line items without shipping) and explains that Medusa's `subtotal` includes shipping.
- `get_customer` reports `total_spent` with upper-case currency codes, like `sales_report`.
- `set_stock_level` explains that a variant without an inventory item does not track inventory (`manage_inventory = false`).
- The server refuses a publishable key (`pk_…`) with a clear message instead of failing every call with 401.
- `npm run smoke` checks that key fields are present, because Medusa silently drops fields it does not return.
