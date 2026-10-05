import type { MedusaConfig } from "./config.js";

export class MedusaError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

type QueryValue = string | number | boolean | null | undefined | QueryValue[] | { [k: string]: QueryValue };

/** Serializes nested objects/arrays the way Medusa expects: a[b][$gte]=x, a[]=1&a[]=2 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const out: string[] = [];
  const walk = (key: string, val: QueryValue) => {
    if (val === undefined || val === null || val === "") return;
    if (Array.isArray(val)) {
      val.forEach((v) => walk(`${key}[]`, v));
    } else if (typeof val === "object") {
      for (const [k, v] of Object.entries(val)) walk(`${key}[${k}]`, v);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type UploadFile = { filename: string; mimeType: string; data: Uint8Array };

export class MedusaClient {
  private authHeader: string;
  private cache = new Map<string, { at: number; value: Promise<any> }>();

  constructor(private cfg: MedusaConfig) {
    // Medusa v2: the secret API key goes in Basic auth as the username with an empty password
    this.authHeader = "Basic " + Buffer.from(`${cfg.apiKey}:`).toString("base64");
  }

  async request<T = any>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, QueryValue>; body?: unknown; form?: FormData } = {},
  ): Promise<T> {
    // Any write may change cached store data (regions, locations…)
    if (method !== "GET") this.cache.clear();
    const qs = opts.query ? buildQuery(opts.query) : "";
    const url = `${this.cfg.backendUrl}${path}${qs ? `?${qs}` : ""}`;
    // Only GETs are retried – repeating a write could apply it twice
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(opts.body !== undefined && !opts.form ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
          signal: ctrl.signal,
        });
      } catch (e: any) {
        clearTimeout(t);
        if (attempt < attempts) {
          await sleep(400 * 3 ** (attempt - 1));
          continue;
        }
        const reason = e?.name === "AbortError" ? `timed out after ${this.cfg.timeoutMs} ms` : (e?.message ?? String(e));
        throw new MedusaError(0, `Cannot reach Medusa (${method} ${path}): ${reason}`);
      }
      clearTimeout(t);
      if (RETRY_STATUS.has(res.status) && attempt < attempts) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : 400 * 3 ** (attempt - 1));
        continue;
      }
      const text = await res.text();
      let data: any = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || res.statusText;
        throw new MedusaError(res.status, `Medusa ${res.status} ${method} ${path}: ${msg}`, data);
      }
      return data as T;
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }
  post<T = any>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("POST", path, { body: body ?? {}, query });
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }

  /** GET that is cached for a short time – for store data that rarely changes (regions, locations, channels). */
  cachedGet<T = any>(path: string, query?: Record<string, QueryValue>, ttlMs = 60_000): Promise<T> {
    const key = `${path}?${query ? buildQuery(query) : ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = this.get<T>(path, query);
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** Uploads files to the store's file storage; returns their public URLs. */
  async upload(files: UploadFile[]): Promise<{ id: string; url: string }[]> {
    const form = new FormData();
    for (const f of files) form.append("files", new Blob([new Uint8Array(f.data)], { type: f.mimeType }), f.filename);
    const res = await this.request<any>("POST", "/admin/uploads", { form });
    return res.files ?? [];
  }

  /** Walks all pages of a list endpoint (capped at maxItems). */
  async listAll<T = any>(
    path: string,
    key: string,
    query: Record<string, QueryValue>,
    maxItems = 5000,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ items: T[]; truncated: boolean; count: number }> {
    const pageSize = 200;
    const items: T[] = [];
    let offset = 0;
    let count = 0;
    while (true) {
      const res = await this.get<any>(path, { ...query, limit: pageSize, offset });
      const page: T[] = res[key] ?? [];
      count = res.count ?? page.length;
      items.push(...page);
      offset += page.length;
      onProgress?.(Math.min(items.length, maxItems), Math.min(count, maxItems));
      if (page.length === 0 || offset >= count) break;
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), truncated: true, count };
    }
    return { items, truncated: false, count };
  }
}
