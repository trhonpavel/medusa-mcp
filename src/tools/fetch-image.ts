import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { UploadFile } from "../medusa.js";

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

/** Loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return (
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe8") ||
      v.startsWith("fe9") ||
      v.startsWith("fea") ||
      v.startsWith("feb") ||
      v.startsWith("ff")
    );
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

async function assertPublicUrl(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http(s) image URLs are allowed: ${url.href}`);
  if (url.username || url.password) throw new Error("Image URLs must not contain credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new Error(`Refusing to fetch ${url.host}: it resolves to a private or local address.`);
}

/**
 * Downloads an image from a public URL. Private and local addresses are refused (also after redirects),
 * so the server cannot be used to reach its own network.
 */
export async function fetchImage(rawUrl: string, timeoutMs = 20_000): Promise<UploadFile> {
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects for ${rawUrl}`);
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`Downloading ${url.href} failed: HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!TYPES[type]) throw new Error(`${url.href} is not a supported image (content-type: ${type || "none"}).`);
    const declared = Number(res.headers.get("content-length"));
    if (declared > MAX_BYTES) throw new Error(`Image is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error(`Image is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
      chunks.push(chunk);
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.byteLength;
    }
    const base = decodeURIComponent(url.pathname.split("/").pop() || "image").replace(/[^\w.-]+/g, "-").slice(0, 80);
    const filename = /\.\w{2,5}$/.test(base) ? base : `${base}.${TYPES[type]}`;
    return { filename, mimeType: type, data };
  }
}
