import { z } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_TZ, localDate, type ToolContext } from "./tools/helpers.js";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
const today = () => localDate(new Date().toISOString(), DEFAULT_TZ);
const header = () => `Today is ${today()} (store timezone ${DEFAULT_TZ}). Answer in the language I write in.\n\n`;
const startsWith = (options: string[]) => (value: string | undefined) =>
  options.filter((o) => o.toLowerCase().startsWith((value ?? "").toLowerCase()));

function lastMonths(n: number): string[] {
  const [y, m] = today().split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

/** Ready-made workflows that clients offer as slash commands. */
export function registerPrompts(server: McpServer, ctx: ToolContext) {
  const { medusa, cfg } = ctx;
  const readOnlyNote = cfg.readOnly ? "\n\nThe server is read-only: describe the actions instead of performing them." : "";

  const orderArg = completable(z.string().describe("Order number or ID"), async (value) => {
    try {
      const res = await medusa.get("/admin/orders", { fields: "id,display_id", order: "-created_at", q: value || undefined, limit: 20 });
      return (res.orders ?? []).map((o: any) => String(o.display_id)).filter((n: string) => n.startsWith(value ?? ""));
    } catch {
      return [];
    }
  });

  server.registerPrompt(
    "store_briefing",
    {
      title: "Store briefing",
      description: "A short overview: sales vs the previous period, orders waiting for fulfillment, stock that runs out, anything unusual.",
      argsSchema: {
        period: completable(
          z.string().optional().describe("today, yesterday, last_7_days or this_month (default today)"),
          startsWith(["today", "yesterday", "last_7_days", "this_month"]),
        ),
      },
    },
    ({ period }) =>
      user(
        header() +
          `Give me a briefing of my Medusa store for ${period || "today"}.\n` +
          "1. Call sales_report for that period (compare: previous_period) and summarize revenue, orders, average order value and the biggest changes.\n" +
          "2. Call list_orders with fulfillment_status ['not_fulfilled','partially_fulfilled'] and list the paid ones waiting to be shipped (oldest first).\n" +
          "3. Call inventory_forecast and name the SKUs that are out of stock or should be reordered now.\n" +
          "4. Mention anything unusual: refunds, canceled orders, unpaid orders older than 3 days, a sudden drop or spike.\n" +
          "Keep it to a few bullet points with concrete numbers. Do not change anything.",
      ),
  );

  server.registerPrompt(
    "fulfill_orders",
    {
      title: "Fulfill orders",
      description: "Pack and ship paid orders – fulfillment, tracking number, customer notification – with confirmation first.",
      argsSchema: {
        orders: z.string().optional().describe("Order numbers, optionally with tracking numbers, e.g. '1042 Z123, 1043'"),
      },
    },
    ({ orders }) =>
      user(
        header() +
          (orders
            ? `I want to ship these orders: ${orders}.\n`
            : "Find paid orders waiting to be shipped: list_orders with fulfillment_status ['not_fulfilled','partially_fulfilled'] and payment_status ['captured','authorized'].\n") +
          "For each order show the number, customer, items still to fulfill and the tracking number if I gave one. Leave out unpaid or canceled orders and say why.\n" +
          "Ask me to confirm the list and whether customers should be notified. Then for each confirmed order call create_fulfillment, " +
          "and create_shipment with the tracking number when there is one. Report the result per order and list failures at the end." +
          readOnlyNote,
      ),
  );

  server.registerPrompt(
    "restock_plan",
    {
      title: "Restock plan",
      description: "What to reorder and how much, based on sales velocity, stock and lead time.",
      argsSchema: {
        lead_time_days: z.string().optional().describe("Supplier lead time in days (default 14)"),
        coverage_days: z.string().optional().describe("How many days the order should cover (default 30)"),
      },
    },
    ({ lead_time_days, coverage_days }) =>
      user(
        header() +
          `Plan restocking: call inventory_forecast with lead_time_days ${Number(lead_time_days) || 14} and coverage_days ${Number(coverage_days) || 30}.\n` +
          "Summarize what is out of stock, what to reorder now and soon, with suggested quantities, and list slow movers that tie up stock.\n" +
          "If I then tell you what was delivered, update stock with bulk_set_stock – preview first (dry_run), apply only after I confirm." +
          readOnlyNote,
      ),
  );

  server.registerPrompt(
    "handle_return",
    {
      title: "Handle a return",
      description: "Return items from an order: request the return, receive the parcel, refund the customer.",
      argsSchema: { order: orderArg },
    },
    ({ order }) =>
      user(
        header() +
          `A customer wants to return items from order ${order}.\n` +
          "1. Call get_order and show the shipped items, what was paid and what was already refunded or returned.\n" +
          "2. Ask me which items and quantities come back and why (return reasons are in get_store_info).\n" +
          "3. create_return for those items. If the parcel has already arrived, receive_return right away.\n" +
          "4. Propose the refund amount (items returned; shipping only if I say so) and call refund_payment only after I confirm the amount." +
          readOnlyNote,
      ),
  );

  server.registerPrompt(
    "customer_overview",
    {
      title: "Customer overview",
      description: "Everything about one customer – orders, spend, open issues – and suggestions.",
      argsSchema: {
        customer: completable(z.string().describe("E-mail or name"), async (value) => {
          try {
            const res = await medusa.get("/admin/customers", { fields: "email", q: value || undefined, limit: 20 });
            return (res.customers ?? []).map((c: any) => c.email).filter(Boolean);
          } catch {
            return [];
          }
        }),
      },
    },
    ({ customer }) =>
      user(
        header() +
          `Tell me about the customer "${customer}". Find them with list_customers, then call get_customer.\n` +
          "Summarize: since when they buy, number of orders, total spent, average order, last order and what they buy. " +
          "Point out open issues (unshipped or unpaid orders, returns, refunds) with get_order where needed. " +
          "End with one or two ideas (e.g. a thank-you code with create_promotion) – but do not create anything without my approval.",
      ),
  );

  server.registerPrompt(
    "monthly_report",
    {
      title: "Monthly report",
      description: "Management summary of a month: sales vs previous month and last year, customers, products, discount codes.",
      argsSchema: {
        month: completable(z.string().describe("Month as YYYY-MM"), startsWith(lastMonths(13))),
      },
    },
    ({ month }) => {
      const [y, m] = month.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const from = `${month}-01`;
      const to = last > today() ? today() : last;
      return user(
        header() +
          `Write a monthly report for ${month} (${from} – ${to}).\n` +
          `1. sales_report from ${from} to ${to}, group_by week, compare previous_period, include ['countries','discount_codes','variants'].\n` +
          `2. sales_report for the same dates with compare previous_year (totals only matter).\n` +
          `3. customer_report from ${from} to ${to}.\n` +
          "Then write: headline numbers with changes, what drove them (products, codes, countries), customers (new vs returning, repeat rate, top customers), " +
          "and three concrete recommendations for next month.",
      );
    },
  );

  server.registerPrompt(
    "plan_promotion",
    {
      title: "Plan a promotion",
      description: "Design a discount campaign, check overlaps with existing codes, and create it as a draft for approval.",
      argsSchema: {
        goal: z.string().optional().describe("E.g. 'clear winter stock', '15 % for returning customers in November'"),
      },
    },
    ({ goal }) =>
      user(
        header() +
          `Help me plan a promotion${goal ? `: ${goal}` : ""}.\n` +
          "1. Check list_promotions for overlapping active codes, and use sales_report / inventory_forecast if it helps to pick products.\n" +
          "2. Propose: code, discount type and value, which products or customer groups, dates, usage limit – and the expected effect.\n" +
          "3. After I agree, create it with create_promotion with status 'draft', show it, and activate it with update_promotion only when I say so." +
          readOnlyNote,
      ),
  );
}
