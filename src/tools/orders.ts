import { z } from "zod";
import {
  addressSchema,
  money,
  CREATE,
  dateFilter,
  defined,
  DESTRUCTIVE,
  FULFILLMENT_STATUSES,
  limitSchema,
  metadataSchema,
  offsetSchema,
  ORDER_LIST_FIELDS,
  PAYMENT_STATUSES,
  RO,
  round2,
  summarizeOrder,
  UPDATE,
  type ToolContext,
} from "./helpers.js";

const sum = (xs: any[] | undefined) => round2((xs ?? []).reduce((s, x) => s + Number(x.amount ?? 0), 0));

function shapePayment(p: any) {
  const captured = sum(p.captures);
  const refunded = sum(p.refunds);
  return {
    id: p.id,
    provider: p.provider_id,
    amount: p.amount,
    currency: p.currency_code,
    captured,
    refunded,
    refundable: round2(captured - refunded),
    captured_at: p.captured_at ?? undefined,
    canceled_at: p.canceled_at ?? undefined,
    refunds: (p.refunds ?? []).map((r: any) => ({
      amount: r.amount,
      note: r.note ?? undefined,
      reason: r.refund_reason?.label,
      created_at: r.created_at,
    })),
  };
}

/** Full order detail – shared by get_order and the order resource. */
export async function loadOrderDetail(ctx: ToolContext, ref: string) {
  const { medusa, resolveOrderId } = ctx;
  const id = await resolveOrderId(ref);
  // Every field is prefixed with + or *: a single plain field would make Medusa drop its defaults
  // (display_id, totals, email, currency_code…).
  const [res, returns] = await Promise.all([
    medusa.get(`/admin/orders/${id}`, {
      fields:
        "+summary,+email,+currency_code,+metadata,*items,*items.detail,*items.adjustments,*shipping_address,*billing_address," +
        "*customer,*shipping_methods,*fulfillments,*fulfillments.items,*fulfillments.labels,*payment_collections," +
        "*payment_collections.payments,*payment_collections.payments.captures,*payment_collections.payments.refunds",
    }),
    medusa
      .get("/admin/returns", { order_id: id, fields: "id,status,created_at,received_at,canceled_at,*items", limit: 50 })
      .then((r) => (r.returns ?? []) as any[])
      .catch(() => undefined),
  ]);
  const o = res.order;
  const discounts: Record<string, number> = {};
  for (const i of o.items ?? [])
    for (const adj of i.adjustments ?? [])
      if (adj.code) discounts[adj.code] = round2((discounts[adj.code] ?? 0) + Number(adj.amount ?? 0));
  const addr = (a: any) =>
    a && {
      name: [a.first_name, a.last_name].filter(Boolean).join(" ") || undefined,
      company: a.company,
      address_1: a.address_1,
      address_2: a.address_2,
      city: a.city,
      postal_code: a.postal_code,
      province: a.province,
      country_code: a.country_code,
      phone: a.phone,
    };
  return {
    ...summarizeOrder(o),
    customer_id: o.customer_id ?? o.customer?.id,
    subtotal: o.subtotal,
    shipping_total: o.shipping_total,
    tax_total: o.tax_total,
    discount_total: o.discount_total,
    discount_codes: Object.keys(discounts).length ? discounts : undefined,
    paid_total: o.summary?.paid_total,
    refunded_total: o.summary?.refunded_total,
    outstanding: o.summary?.pending_difference || undefined,
    items: (o.items ?? []).map((i: any) => ({
      id: i.id,
      title: i.product_title ?? i.title,
      variant: i.variant_title,
      sku: i.variant_sku,
      variant_id: i.variant_id,
      quantity: i.quantity,
      unit_price: i.unit_price,
      total: i.total,
      fulfilled: i.detail?.fulfilled_quantity,
      shipped: i.detail?.shipped_quantity,
      returned: i.detail?.return_received_quantity || undefined,
    })),
    shipping_address: addr(o.shipping_address),
    billing_address: addr(o.billing_address),
    shipping_methods: (o.shipping_methods ?? []).map((m: any) => ({ name: m.name, amount: m.amount })),
    fulfillments: (o.fulfillments ?? []).map((f: any) => ({
      id: f.id,
      location_id: f.location_id,
      created_at: f.created_at,
      shipped_at: f.shipped_at,
      delivered_at: f.delivered_at,
      canceled_at: f.canceled_at,
      items: (f.items ?? []).map((i: any) => ({ line_item_id: i.line_item_id, quantity: i.quantity, title: i.title })),
      tracking: (f.labels ?? []).map((l: any) => ({ number: l.tracking_number, url: l.tracking_url })),
    })),
    payments: (o.payment_collections ?? []).map((p: any) => ({
      id: p.id,
      status: p.status,
      amount: p.amount,
      captured: p.captured_amount,
      refunded: p.refunded_amount,
      payments: p.payments ? p.payments.map(shapePayment) : undefined,
    })),
    returns: returns?.map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      received_at: r.received_at ?? undefined,
      canceled_at: r.canceled_at ?? undefined,
      items: (r.items ?? []).map((i: any) => ({
        line_item_id: i.item_id,
        quantity: i.quantity,
        received: i.received_quantity,
      })),
    })),
    metadata: o.metadata,
  };
}

export function registerOrderTools(ctx: ToolContext) {
  const { tool, medusa, cfg, confirm, resolveOrderId, resolveLocationId, resolveRegionId, variantIdBySku } = ctx;

  async function loadPayments(orderId: string) {
    const o = (
      await medusa.get(`/admin/orders/${orderId}`, {
        fields:
          "+currency_code,+summary,*payment_collections,*payment_collections.payments," +
          "*payment_collections.payments.captures,*payment_collections.payments.refunds",
      })
    ).order;
    const collections: any[] = o.payment_collections ?? [];
    const payments = collections.flatMap((c) => (c.payments ?? []).map(shapePayment));
    return { order: o, collections, payments };
  }

  async function loadFulfillments(orderId: string) {
    const o = (await medusa.get(`/admin/orders/${orderId}`, { fields: "id,*fulfillments,*fulfillments.items" })).order;
    return (o.fulfillments ?? []) as any[];
  }

  /** Write responses omit the status, so read it back. */
  async function fulfillmentStatus(orderId: string): Promise<string | undefined> {
    return (await medusa.get(`/admin/orders/${orderId}`, { fields: "id,fulfillment_status" })).order?.fulfillment_status;
  }

  function pickFulfillment(all: any[], id: string | undefined, candidates: any[], what: string) {
    if (id) {
      const f = all.find((x) => x.id === id);
      if (!f) throw new Error(`Fulfillment ${id} not found on this order.`);
      return f;
    }
    if (candidates.length === 1) return candidates[0];
    throw new Error(
      candidates.length === 0
        ? `The order has no fulfillment that can be ${what}.`
        : `Multiple fulfillments can be ${what}, specify fulfillment_id: ${candidates.map((x) => x.id).join(", ")}`,
    );
  }

  // ===== Read =====
  tool(
    "list_orders",
    {
      title: "List orders",
      description:
        "Lists orders, newest first. Filters: full-text, date range (YYYY-MM-DD in the reporting timezone), customer, order/payment/fulfillment status.",
      inputSchema: {
        q: z.string().optional().describe("Full-text search – order number, email, name…"),
        created_from: z.string().optional().describe("From date, e.g. 2026-09-01"),
        created_to: z.string().optional().describe("To date (inclusive), e.g. 2026-09-30"),
        customer_id: z.string().optional(),
        status: z
          .array(z.enum(["pending", "completed", "draft", "archived", "canceled", "requires_action"]))
          .optional()
          .describe("Order status"),
        payment_status: z.array(z.enum(PAYMENT_STATUSES)).optional(),
        fulfillment_status: z
          .array(z.enum(FULFILLMENT_STATUSES))
          .optional()
          .describe("E.g. ['not_fulfilled'] = waiting to be fulfilled"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    async (a) => {
      const query: Record<string, any> = {
        fields: ORDER_LIST_FIELDS,
        order: "-created_at",
        q: a.q,
        customer_id: a.customer_id,
        status: a.status,
        created_at: dateFilter(a.created_from, a.created_to),
      };
      // payment/fulfillment status are not API filters -> filter client-side
      if (a.payment_status?.length || a.fulfillment_status?.length) {
        const all = await medusa.listAll("/admin/orders", "orders", query, 3000);
        const filtered = all.items.filter(
          (o: any) =>
            (!a.payment_status?.length || a.payment_status.includes(o.payment_status)) &&
            (!a.fulfillment_status?.length || a.fulfillment_status.includes(o.fulfillment_status)),
        );
        return {
          count: filtered.length,
          offset: a.offset,
          scanned: all.items.length,
          scan_truncated: all.truncated || undefined,
          orders: filtered.slice(a.offset, a.offset + a.limit).map(summarizeOrder),
        };
      }
      const res = await medusa.get("/admin/orders", { ...query, limit: a.limit, offset: a.offset });
      return { count: res.count, offset: res.offset, orders: (res.orders ?? []).map(summarizeOrder) };
    },
  );

  tool(
    "get_order",
    {
      title: "Get order",
      description:
        "Full order detail – line items, addresses, payments (with captures and refunds), fulfillments, tracking numbers and returns. " +
        "Accepts an order ID (order_…) or the order number.",
      inputSchema: { order: z.string().describe("Order ID (order_…) or order number, e.g. 1042") },
      annotations: RO,
    },
    async (a) => loadOrderDetail(ctx, a.order),
  );

  if (cfg.readOnly) return;

  // ===== Fulfillment =====
  tool(
    "create_fulfillment",
    {
      title: "Create fulfillment",
      description:
        "Creates a fulfillment for an order. Without 'items' it fulfills all remaining unfulfilled quantities. " +
        "Without 'location_id' it uses the only stock location, if there is exactly one.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        location_id: z.string().optional().describe("Stock location to ship from"),
        items: z
          .array(z.object({ line_item_id: z.string(), quantity: z.number().int().positive() }))
          .optional()
          .describe("Specific line items; defaults to everything remaining"),
        notify_customer: z.boolean().default(true),
      },
      annotations: CREATE,
    },
    async (a) => {
      const id = await resolveOrderId(a.order);
      let items = a.items?.map((i) => ({ id: i.line_item_id, quantity: i.quantity }));
      if (!items) {
        const o = (await medusa.get(`/admin/orders/${id}`, { fields: "id,*items,*items.detail" })).order;
        items = (o.items ?? [])
          .map((i: any) => ({
            id: i.id,
            quantity: Number(i.quantity ?? 0) - Number(i.detail?.fulfilled_quantity ?? 0),
          }))
          .filter((i: any) => i.quantity > 0);
        if (!items!.length) throw new Error("The order has no unfulfilled items.");
      }
      const locationId = await resolveLocationId(a.location_id);
      await medusa.post(`/admin/orders/${id}/fulfillments`, {
        items,
        location_id: locationId,
        no_notification: !a.notify_customer,
        metadata: {},
      });
      return {
        ok: true,
        order_id: id,
        fulfillment_status: await fulfillmentStatus(id),
        fulfilled_items: items,
        location_id: locationId,
      };
    },
  );

  tool(
    "create_shipment",
    {
      title: "Mark as shipped",
      description:
        "Marks a fulfillment as shipped and attaches a tracking number. Without 'fulfillment_id' it uses the only unshipped fulfillment.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        fulfillment_id: z.string().optional(),
        tracking_number: z.string().optional(),
        tracking_url: z.string().optional(),
        notify_customer: z.boolean().default(true),
      },
      annotations: CREATE,
    },
    async (a) => {
      const id = await resolveOrderId(a.order);
      const all = await loadFulfillments(id);
      const open = all.filter((f) => !f.shipped_at && !f.canceled_at);
      if (!a.fulfillment_id && !open.length)
        throw new Error("The order has no unshipped fulfillment – call create_fulfillment first.");
      const f = pickFulfillment(all, a.fulfillment_id, open, "shipped");
      const body: any = {
        items: (f.items ?? []).map((i: any) => ({ id: i.line_item_id, quantity: i.quantity })),
        no_notification: !a.notify_customer,
        metadata: {},
      };
      if (a.tracking_number || a.tracking_url) {
        body.labels = [
          { tracking_number: a.tracking_number ?? "", tracking_url: a.tracking_url ?? "", label_url: "" },
        ];
      }
      await medusa.post(`/admin/orders/${id}/fulfillments/${f.id}/shipments`, body);
      return { ok: true, order_id: id, fulfillment_id: f.id, fulfillment_status: await fulfillmentStatus(id) };
    },
  );

  tool(
    "mark_delivered",
    {
      title: "Mark as delivered",
      description:
        "Marks a fulfillment as delivered. Without 'fulfillment_id' it uses the only fulfillment that is not delivered yet.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        fulfillment_id: z.string().optional(),
      },
      annotations: UPDATE,
    },
    async (a) => {
      const id = await resolveOrderId(a.order);
      const all = await loadFulfillments(id);
      const f = pickFulfillment(
        all,
        a.fulfillment_id,
        all.filter((x) => !x.delivered_at && !x.canceled_at),
        "marked as delivered",
      );
      await medusa.post(`/admin/orders/${id}/fulfillments/${f.id}/mark-as-delivered`, {});
      return { ok: true, order_id: id, fulfillment_id: f.id, fulfillment_status: await fulfillmentStatus(id) };
    },
  );

  tool(
    "cancel_fulfillment",
    {
      title: "Cancel fulfillment",
      description:
        "Cancels a fulfillment that has not been shipped yet, so its items can be fulfilled again. " +
        "Without 'fulfillment_id' it uses the only unshipped fulfillment.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        fulfillment_id: z.string().optional(),
        notify_customer: z.boolean().default(false),
      },
      annotations: DESTRUCTIVE,
    },
    async (a, extra) => {
      const id = await resolveOrderId(a.order);
      const all = await loadFulfillments(id);
      const f = pickFulfillment(
        all,
        a.fulfillment_id,
        all.filter((x) => !x.shipped_at && !x.canceled_at),
        "canceled",
      );
      const units = (f.items ?? []).reduce((n: number, i: any) => n + Number(i.quantity ?? 0), 0);
      await confirm(extra, `Cancel fulfillment ${f.id} (${units} units) of order ${a.order}?`);
      await medusa.post(`/admin/orders/${id}/fulfillments/${f.id}/cancel`, {
        no_notification: !a.notify_customer,
      });
      return { ok: true, order_id: id, fulfillment_id: f.id, fulfillment_status: await fulfillmentStatus(id) };
    },
  );

  // ===== Order lifecycle =====
  tool(
    "complete_order",
    {
      title: "Complete order",
      description: "Marks the order as completed.",
      inputSchema: { order: z.string().describe("Order ID or order number") },
      annotations: UPDATE,
    },
    async (a) => {
      const id = await resolveOrderId(a.order);
      const res = await medusa.post(`/admin/orders/${id}/complete`, {});
      return { ok: true, order_id: id, status: res.order?.status };
    },
  );

  tool(
    "cancel_order",
    {
      title: "Cancel order",
      description:
        "CANCELS the order. Irreversible – get explicit confirmation from the user before calling. The order must not have active fulfillments.",
      inputSchema: { order: z.string().describe("Order ID or order number") },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async (a, extra) => {
      const id = await resolveOrderId(a.order);
      const o = (await medusa.get(`/admin/orders/${id}`, { fields: "id,display_id,email,total,currency_code,status" })).order;
      await confirm(extra, `Cancel order #${o.display_id} (${o.email}, ${money(o.total, o.currency_code)})? This cannot be undone.`);
      const res = await medusa.post(`/admin/orders/${id}/cancel`);
      return { ok: true, order_id: id, status: res.order?.status, payment_status: res.order?.payment_status };
    },
  );

  tool(
    "update_order",
    {
      title: "Update order",
      description:
        "Changes the order's email, shipping or billing address, or metadata (e.g. an internal note). Send only what should change; " +
        "an address replaces the whole previous address.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        email: z.string().optional(),
        shipping_address: addressSchema.optional(),
        billing_address: addressSchema.optional(),
        metadata: metadataSchema,
      },
      annotations: UPDATE,
    },
    async ({ order, ...fields }) => {
      const id = await resolveOrderId(order);
      const body = defined(fields);
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      const fieldList = "id,display_id,email,+metadata,*shipping_address,*billing_address";
      const before = (await medusa.get(`/admin/orders/${id}`, { fields: fieldList })).order;
      await medusa.post(`/admin/orders/${id}`, body);
      const after = (await medusa.get(`/admin/orders/${id}`, { fields: fieldList })).order;
      const pick = (o: any) => Object.fromEntries(Object.keys(body).map((k) => [k, o[k]]));
      return { ok: true, order_id: id, before: pick(before), after: pick(after) };
    },
  );

  // ===== Payments =====
  tool(
    "mark_order_paid",
    {
      title: "Mark order as paid",
      description:
        "Records a manual payment (e.g. a received bank transfer or cash on delivery) for the order's unpaid payment collection. " +
        "Orders without one (e.g. converted draft orders) get a payment collection for the outstanding amount first.",
      inputSchema: { order: z.string().describe("Order ID or order number") },
      annotations: UPDATE,
    },
    async (a) => {
      const id = await resolveOrderId(a.order);
      const { order, collections } = await loadPayments(id);
      let unpaid = collections.filter((c) => ["not_paid", "awaiting", "partially_authorized"].includes(c.status));
      if (unpaid.length > 1) throw new Error(`Multiple unpaid payment collections: ${unpaid.map((c) => c.id).join(", ")}`);
      let created = false;
      if (!unpaid.length) {
        const outstanding = Number(order.summary?.pending_difference ?? 0);
        if (outstanding <= 0)
          throw new Error(
            `Nothing to pay – no unpaid payment collection and no outstanding amount (statuses: ${collections.map((c) => c.status).join(", ") || "none"}).`,
          );
        const pc = (await medusa.post("/admin/payment-collections", { order_id: id, amount: outstanding })).payment_collection;
        unpaid = [pc];
        created = true;
      }
      await medusa.post(`/admin/payment-collections/${unpaid[0].id}/mark-as-paid`, { order_id: id });
      const after = (await medusa.get(`/admin/orders/${id}`, { fields: "id,payment_status" })).order;
      return {
        ok: true,
        order_id: id,
        payment_collection_id: unpaid[0].id,
        payment_collection_created: created || undefined,
        payment_status: after.payment_status,
      };
    },
  );

  tool(
    "capture_payment",
    {
      title: "Capture payment",
      description:
        "Captures an authorized payment (charges the customer). Without 'amount' captures the full remaining amount. " +
        "Without 'payment_id' uses the only payment that is not fully captured.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        payment_id: z.string().optional(),
        amount: z.number().positive().optional().describe("Major units; defaults to the full remaining amount"),
      },
      annotations: DESTRUCTIVE,
    },
    async (a, extra) => {
      const id = await resolveOrderId(a.order);
      const { payments } = await loadPayments(id);
      const open = payments.filter((p) => !p.canceled_at && p.captured < Number(p.amount ?? 0));
      const p = a.payment_id ? payments.find((x) => x.id === a.payment_id) : open.length === 1 ? open[0] : undefined;
      if (!p)
        throw new Error(
          a.payment_id
            ? `Payment ${a.payment_id} not found on this order.`
            : open.length === 0
              ? "The order has no payment waiting for capture."
              : `Multiple payments can be captured, specify payment_id: ${open.map((x) => x.id).join(", ")}`,
        );
      await confirm(
        extra,
        `Capture ${money(a.amount ?? Number(p.amount) - p.captured, p.currency)} from the customer for order ${a.order}?`,
      );
      await medusa.post(`/admin/payments/${p.id}/capture`, defined({ amount: a.amount }));
      const after = (await loadPayments(id)).payments.find((x) => x.id === p.id);
      return { ok: true, order_id: id, payment: after };
    },
  );

  tool(
    "refund_payment",
    {
      title: "Refund payment",
      description:
        "REFUNDS money to the customer through the payment provider. Irreversible – confirm the amount with the user before calling. " +
        "Without 'payment_id' uses the only captured payment that can cover the amount. Refund reasons are listed by get_store_info.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        amount: z.number().positive().describe("Major units, e.g. 249.50"),
        payment_id: z.string().optional(),
        refund_reason_id: z.string().optional(),
        note: z.string().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (a, extra) => {
      const id = await resolveOrderId(a.order);
      const { payments } = await loadPayments(id);
      const fits = payments.filter((p) => p.refundable >= a.amount);
      const p = a.payment_id ? payments.find((x) => x.id === a.payment_id) : fits.length === 1 ? fits[0] : undefined;
      if (!p)
        throw new Error(
          a.payment_id
            ? `Payment ${a.payment_id} not found on this order.`
            : fits.length === 0
              ? `No payment has ${a.amount} left to refund (refundable: ${payments.map((x) => `${x.id} ${x.refundable}`).join(", ") || "none"}).`
              : `Multiple payments can cover the refund, specify payment_id: ${fits.map((x) => x.id).join(", ")}`,
        );
      if (a.amount > p.refundable) throw new Error(`Payment ${p.id} has only ${p.refundable} left to refund.`);
      await confirm(
        extra,
        `Refund ${money(a.amount, p.currency)} to the customer of order ${a.order} via ${p.provider}?${a.note ? ` Note: ${a.note}` : ""}`,
      );
      await medusa.post(
        `/admin/payments/${p.id}/refund`,
        defined({ amount: a.amount, refund_reason_id: a.refund_reason_id, note: a.note }),
      );
      const after = await loadPayments(id);
      const status = (await medusa.get(`/admin/orders/${id}`, { fields: "id,payment_status" })).order.payment_status;
      return { ok: true, order_id: id, payment_status: status, payment: after.payments.find((x) => x.id === p.id) };
    },
  );

  // ===== Returns =====
  tool(
    "create_return",
    {
      title: "Create return",
      description:
        "Requests a return of order items (the customer is sending them back). Without 'items' returns every shipped item. " +
        "When the parcel arrives, call receive_return. Refund the money separately with refund_payment. " +
        "Return reasons are listed by get_store_info.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        items: z
          .array(
            z.object({
              line_item_id: z.string(),
              quantity: z.number().int().positive(),
              reason_id: z.string().optional(),
              note: z.string().optional(),
            }),
          )
          .optional()
          .describe("Defaults to every shipped item"),
        location_id: z.string().optional().describe("Where the goods return to; defaults to the only stock location"),
        note: z.string().optional().describe("Internal note"),
        notify_customer: z.boolean().default(true),
      },
      annotations: CREATE,
    },
    async (a) => {
      const id = await resolveOrderId(a.order);
      let items = a.items?.map((i) => defined({ id: i.line_item_id, quantity: i.quantity, reason_id: i.reason_id, internal_note: i.note }));
      if (!items) {
        const o = (await medusa.get(`/admin/orders/${id}`, { fields: "id,*items,*items.detail" })).order;
        items = (o.items ?? [])
          .map((i: any) => ({
            id: i.id,
            quantity:
              Number(i.detail?.shipped_quantity ?? 0) -
              Number(i.detail?.return_requested_quantity ?? 0) -
              Number(i.detail?.return_received_quantity ?? 0),
          }))
          .filter((i: any) => i.quantity > 0);
        if (!items!.length) throw new Error("The order has no shipped items that could be returned.");
      }
      const locationId = await resolveLocationId(a.location_id);
      const ret = (
        await medusa.post("/admin/returns", defined({
          order_id: id,
          location_id: locationId,
          internal_note: a.note,
          no_notification: !a.notify_customer,
        }))
      ).return;
      try {
        await medusa.post(`/admin/returns/${ret.id}/request-items`, { items });
        const res = await medusa.post(`/admin/returns/${ret.id}/request`, { no_notification: !a.notify_customer });
        return { ok: true, order_id: id, return_id: ret.id, status: res.return?.status, location_id: locationId, items };
      } catch (e) {
        // Drop the half-created return request so it does not block the order
        await medusa.delete(`/admin/returns/${ret.id}/request`).catch(() => undefined);
        throw e;
      }
    },
  );

  tool(
    "receive_return",
    {
      title: "Receive return",
      description:
        "Records that returned items arrived; they go back to stock. Without 'items' receives everything requested. " +
        "Without 'return_id' uses the order's only open return.",
      inputSchema: {
        order: z.string().optional().describe("Order ID or order number (to find the return)"),
        return_id: z.string().optional(),
        items: z
          .array(z.object({ line_item_id: z.string(), quantity: z.number().int().positive() }))
          .optional()
          .describe("Defaults to every requested item"),
        note: z.string().optional().describe("Internal note"),
        notify_customer: z.boolean().default(true),
      },
      annotations: CREATE,
    },
    async (a) => {
      let ret: any;
      const fields = "id,status,order_id,*items";
      if (a.return_id) {
        ret = (await medusa.get(`/admin/returns/${a.return_id}`, { fields })).return;
      } else if (a.order) {
        const orderId = await resolveOrderId(a.order);
        const res = await medusa.get("/admin/returns", { order_id: orderId, fields, limit: 50 });
        const open = (res.returns ?? []).filter((r: any) => ["requested", "partially_received"].includes(r.status));
        if (open.length !== 1)
          throw new Error(
            open.length === 0
              ? "The order has no open return – call create_return first."
              : `Multiple open returns, specify return_id: ${open.map((r: any) => r.id).join(", ")}`,
          );
        ret = open[0];
      } else throw new Error("Provide return_id or order.");

      const items =
        a.items?.map((i) => ({ id: i.line_item_id, quantity: i.quantity })) ??
        (ret.items ?? [])
          .map((i: any) => ({ id: i.item_id, quantity: Number(i.quantity ?? 0) - Number(i.received_quantity ?? 0) }))
          .filter((i: any) => i.quantity > 0);
      if (!items.length) throw new Error("Nothing left to receive on this return.");

      await medusa.post(`/admin/returns/${ret.id}/receive`, defined({ internal_note: a.note }));
      try {
        await medusa.post(`/admin/returns/${ret.id}/receive-items`, { items });
        const res = await medusa.post(`/admin/returns/${ret.id}/receive/confirm`, { no_notification: !a.notify_customer });
        return { ok: true, return_id: ret.id, order_id: ret.order_id, status: res.return?.status, received: items };
      } catch (e) {
        await medusa.delete(`/admin/returns/${ret.id}/receive`).catch(() => undefined);
        throw e;
      }
    },
  );

  // ===== Order edits =====
  tool(
    "edit_order",
    {
      title: "Edit order items",
      description:
        "Changes the items of an existing order: add products (by SKU or variant), change quantities, or remove items (quantity 0). " +
        "dry_run (default true) previews the new items and totals and changes nothing; repeat with dry_run false to apply. " +
        "The result says whether the customer owes money (mark_order_paid) or should get a refund (refund_payment).",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        add_items: z
          .array(
            z.object({
              variant_id: z.string().optional(),
              sku: z.string().optional(),
              quantity: z.number().int().positive(),
              unit_price: z.number().nonnegative().optional().describe("Custom price in major units"),
            }),
          )
          .optional(),
        change_items: z
          .array(z.object({ line_item_id: z.string(), quantity: z.number().int().min(0).describe("0 removes the item") }))
          .optional(),
        note: z.string().optional().describe("Internal note"),
        dry_run: z.boolean().default(true),
      },
      annotations: DESTRUCTIVE,
      isWrite: (a) => !a.dry_run,
    },
    async (a, extra) => {
      if (!a.add_items?.length && !a.change_items?.length) throw new Error("Provide add_items or change_items.");
      const id = await resolveOrderId(a.order);
      const before = (
        await medusa.get(`/admin/orders/${id}`, {
          fields: "id,display_id,status,total,currency_code,+summary,*items",
        })
      ).order;
      if (["canceled", "archived", "draft"].includes(before.status))
        throw new Error(`Order #${before.display_id} is ${before.status} and cannot be edited.`);
      const add = [];
      for (const i of a.add_items ?? []) {
        const variant_id = i.variant_id ?? (i.sku ? await variantIdBySku(i.sku) : undefined);
        if (!variant_id) throw new Error("Each added item needs variant_id or sku.");
        add.push(defined({ variant_id, quantity: i.quantity, unit_price: i.unit_price }));
      }
      for (const c of a.change_items ?? [])
        if (!(before.items ?? []).some((i: any) => i.id === c.line_item_id))
          throw new Error(`Line item ${c.line_item_id} is not on order #${before.display_id}.`);

      await medusa.post("/admin/order-edits", defined({ order_id: id, internal_note: a.note }));
      let preview: any;
      try {
        if (add.length) preview = (await medusa.post(`/admin/order-edits/${id}/items`, { items: add })).order_preview;
        for (const c of a.change_items ?? [])
          preview = (await medusa.post(`/admin/order-edits/${id}/items/item/${c.line_item_id}`, { quantity: c.quantity }))
            .order_preview;
      } catch (e) {
        await medusa.delete(`/admin/order-edits/${id}`).catch(() => undefined);
        throw e;
      }
      const shape = (o: any) =>
        (o.items ?? [])
          .filter((i: any) => Number(i.quantity ?? 0) > 0)
          .map((i: any) => ({
            line_item_id: i.id,
            title: i.product_title ?? i.title,
            variant: i.variant_title,
            sku: i.variant_sku,
            quantity: Number(i.quantity),
            unit_price: i.unit_price,
          }));
      const summary = {
        order: `#${before.display_id}`,
        currency: before.currency_code,
        total_before: before.total,
        total_after: preview?.total,
        difference: round2(Number(preview?.total ?? 0) - Number(before.total ?? 0)),
        items_after: shape(preview ?? before),
      };
      if (a.dry_run) {
        await medusa.delete(`/admin/order-edits/${id}`);
        return { dry_run: true, ...summary, next: "Nothing was changed. Call again with dry_run: false to apply." };
      }
      try {
        await confirm(
          extra,
          `Edit order #${before.display_id}: total ${money(before.total, before.currency_code)} → ${money(preview?.total, before.currency_code)}?`,
        );
        await medusa.post(`/admin/order-edits/${id}/request`, {});
        await medusa.post(`/admin/order-edits/${id}/confirm`, {});
      } catch (e) {
        await medusa.delete(`/admin/order-edits/${id}`).catch(() => undefined);
        throw e;
      }
      const after = (await medusa.get(`/admin/orders/${id}`, { fields: "id,total,+summary" })).order;
      const pending = Number(after.summary?.pending_difference ?? 0);
      return {
        ok: true,
        ...summary,
        total_after: after.total,
        outstanding: pending || undefined,
        next:
          pending > 0
            ? `The customer owes ${money(pending, before.currency_code)} – record it with mark_order_paid once paid.`
            : pending < 0
              ? `The customer paid ${money(-pending, before.currency_code)} too much – refund it with refund_payment.`
              : "Nothing to pay or refund.",
      };
    },
  );

  // ===== Draft orders =====
  tool(
    "create_draft_order",
    {
      title: "Create draft order",
      description:
        "Creates a draft order on behalf of a customer (phone or e-mail orders, B2B). Items by variant_id or SKU (of published products), optionally with a custom unit price. " +
        "Shipping options are listed by get_store_info. Turn the draft into a real order with convert_draft_order.",
      inputSchema: {
        email: z.string().optional().describe("Customer e-mail (required unless customer_id is given)"),
        customer_id: z.string().optional(),
        region_id: z.string().optional().describe("Defaults to the only region"),
        items: z
          .array(
            z.object({
              variant_id: z.string().optional(),
              sku: z.string().optional(),
              title: z.string().optional().describe("For a custom item without a variant"),
              quantity: z.number().int().positive(),
              unit_price: z.number().nonnegative().optional().describe("Custom price in major units"),
            }),
          )
          .min(1),
        shipping_address: addressSchema.optional(),
        billing_address: addressSchema.optional(),
        shipping_option_id: z.string().optional(),
        shipping_amount: z.number().nonnegative().optional().describe("Custom shipping price; defaults to the option's price"),
        promo_codes: z.array(z.string()).optional(),
        notify_customer: z.boolean().default(true),
      },
      annotations: CREATE,
    },
    async (a) => {
      if (!a.email && !a.customer_id) throw new Error("Provide email or customer_id.");
      const regionId = await resolveRegionId(a.region_id);
      const items = [];
      for (const i of a.items) {
        const variantId = i.variant_id ?? (i.sku ? await variantIdBySku(i.sku) : undefined);
        if (!variantId && !i.title) throw new Error("Each item needs variant_id, sku or title.");
        if (!variantId && i.unit_price === undefined) throw new Error(`Custom item "${i.title}" needs a unit_price.`);
        items.push(defined({ variant_id: variantId, title: variantId ? undefined : i.title, quantity: i.quantity, unit_price: i.unit_price }));
      }
      let shipping_methods: any[] | undefined;
      if (a.shipping_option_id) {
        const region = (await medusa.get(`/admin/regions/${regionId}`, { fields: "id,currency_code" })).region;
        const so = (await medusa.get(`/admin/shipping-options/${a.shipping_option_id}`, { fields: "id,name,*prices" }))
          .shipping_option;
        const amount =
          a.shipping_amount ??
          (so.prices ?? []).find((p: any) => p.currency_code === region.currency_code && !p.price_rules?.length)?.amount ??
          (so.prices ?? []).find((p: any) => p.currency_code === region.currency_code)?.amount;
        if (amount === undefined)
          throw new Error(`Shipping option ${so.name} has no ${region.currency_code} price – pass shipping_amount.`);
        shipping_methods = [{ shipping_option_id: so.id, name: so.name, amount }];
      }
      const res = await medusa.post(
        "/admin/draft-orders",
        defined({
          email: a.email,
          customer_id: a.customer_id,
          region_id: regionId,
          items,
          shipping_address: a.shipping_address,
          billing_address: a.billing_address,
          shipping_methods,
          promo_codes: a.promo_codes,
          no_notification_order: !a.notify_customer,
        }),
      );
      const d = res.draft_order;
      return {
        ok: true,
        draft_order_id: d.id,
        display_id: d.display_id,
        currency: d.currency_code,
        total: d.total,
        items: (d.items ?? []).map((i: any) => ({ title: i.title, sku: i.variant_sku, quantity: i.quantity, unit_price: i.unit_price })),
        next: "Review the draft with the user, then call convert_draft_order.",
      };
    },
  );

  tool(
    "convert_draft_order",
    {
      title: "Convert draft order",
      description: "Turns a draft order into a regular order (reserves stock). Record the payment afterwards with mark_order_paid.",
      inputSchema: { draft_order_id: z.string() },
      annotations: CREATE,
    },
    async (a) => {
      const res = await medusa.post(`/admin/draft-orders/${a.draft_order_id}/convert-to-order`, {});
      return { ok: true, order: summarizeOrder(res.order ?? {}) };
    },
  );
}
