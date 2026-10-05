---
name: store-briefing
description: Daily briefing for a Medusa store – yesterday's and month-to-date sales, orders waiting to be fulfilled, and products running low on stock. Use when the user asks how the shop is doing, for a morning summary, or what needs attention today.
---

# Store briefing

Build a short briefing from the Medusa tools. Run the independent calls in parallel.

1. `sales_report` for yesterday (`from` = `to` = yesterday, `group_by: "none"`, `top_n: 5`) and for the month to date (`group_by: "day"`, `top_n: 5`). Both compare with the previous period by default, so you get the changes for free. Dates are in the store's reporting timezone.
2. `list_orders` with `fulfillment_status: ["not_fulfilled", "partially_fulfilled"]` and `payment_status: ["captured", "authorized"]` – paid orders waiting to ship. Note the oldest one and how many days it has waited.
3. `inventory_forecast` (defaults) – what is out of stock or should be reordered now.

Report, in this order:

- **Needs action**: orders waiting to ship (number, customer, age) and SKUs that are out of stock or due for reorder (with the suggested quantity). If there is nothing, say so in one line.
- **Sales**: yesterday and month to date – orders, revenue, net revenue if there were refunds, average order value, per currency, each with the change against the previous period. Use `items_total` when the user asks about goods only, since `subtotal` includes shipping.
- **Top products** and discount codes this month.

Keep it scannable. Clients that support MCP Apps also show the month-to-date report as an interactive dashboard – do not repeat every number from it. Do not call write tools from this skill; offer `fulfill-orders` if orders are waiting.
