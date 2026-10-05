import { RO, type ToolContext } from "./helpers.js";

/** Store overview – shared by get_store_info and the store resource. */
export async function loadStoreInfo(ctx: ToolContext) {
  const { medusa, cfg, getStockLocations } = ctx;
  /** Optional sections must not break the overview, e.g. on older Medusa versions. */
  const optional = <T>(p: Promise<T>) => p.catch(() => undefined);

  const [regions, channels, locations, shipping, profiles, returnReasons, refundReasons] = await Promise.all([
    medusa.cachedGet("/admin/regions", { fields: "id,name,currency_code,*countries", limit: 100 }),
    medusa.cachedGet("/admin/sales-channels", { fields: "id,name,is_disabled", limit: 100 }),
    getStockLocations(),
    optional(medusa.cachedGet("/admin/shipping-options", { fields: "id,name,price_type,*prices,*service_zone", limit: 100 })),
    optional(medusa.cachedGet("/admin/shipping-profiles", { fields: "id,name,type", limit: 100 })),
    optional(medusa.cachedGet("/admin/return-reasons", { fields: "id,value,label", limit: 100 })),
    optional(medusa.cachedGet("/admin/refund-reasons", { fields: "id,label", limit: 100 })),
  ]);
  return {
    regions: (regions.regions ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      currency: r.currency_code,
      countries: (r.countries ?? []).map((c: any) => c.iso_2),
    })),
    sales_channels: channels.sales_channels ?? [],
    stock_locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      city: l.address?.city,
      country: l.address?.country_code,
    })),
    shipping_options: shipping?.shipping_options?.map((s: any) => ({
      id: s.id,
      name: s.name,
      zone: s.service_zone?.name,
      price_type: s.price_type,
      prices: (s.prices ?? [])
        .filter((p: any) => !p.price_rules?.length)
        .map((p: any) => ({ currency: p.currency_code, amount: p.amount })),
    })),
    shipping_profiles: profiles?.shipping_profiles,
    return_reasons: returnReasons?.return_reasons,
    refund_reasons: refundReasons?.refund_reasons,
    read_only: cfg.readOnly,
    timezone: process.env.REPORT_TIMEZONE || "UTC",
  };
}

export function registerStoreTools(ctx: ToolContext) {
  const { tool } = ctx;

  tool(
    "get_store_info",
    {
      title: "Store overview",
      description:
        "Returns regions (currencies), sales channels, stock locations, shipping options and profiles, and return/refund reasons. " +
        "A good first call to learn the IDs other tools need.",
      inputSchema: {},
      annotations: RO,
    },
    async () => loadStoreInfo(ctx),
  );
}
