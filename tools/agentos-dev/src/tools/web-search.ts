/**
 * WebSearch helper — searches via DuckDuckGo HTML (no API key required).
 *
 * Uses Node.js native `https` module with a custom CA bundle to avoid
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY errors on mise/nvm-installed Node on macOS.
 * All errors are caught and returned as { ok: false } — never throws.
 */

import * as https from "node:https";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { z } from "zod";

export const webSearchInputSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().max(30).default(10),
  region: z.string().default("jp-ja"),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export type WebSearchResult = {
  ok: boolean;
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  error?: string;
};

// ---------------------------------------------------------------------------
// System CA bundle detection (cached)
// ---------------------------------------------------------------------------

const CA_PATHS = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/opt/homebrew/etc/openssl@3/cert.pem",
  "/opt/homebrew/etc/ca-certificates/cert.pem",
];

let _cachedCa: string | undefined;

function loadSystemCa(): string | undefined {
  if (_cachedCa !== undefined) return _cachedCa;
  for (const p of CA_PATHS) {
    try {
      _cachedCa = readFileSync(p, "utf8");
      return _cachedCa;
    } catch {
      // try next
    }
  }
  _cachedCa = ""; // not found — use empty string as sentinel
  return undefined;
}

// ---------------------------------------------------------------------------
// Decompress response body based on content-encoding
// ---------------------------------------------------------------------------

function decompressBody(buf: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return buf;
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === "gzip") return gunzipSync(buf);
    if (enc === "deflate") return inflateSync(buf);
    if (enc === "br") return brotliDecompressSync(buf);
  } catch {
    // decompression failed — return raw
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Low-level HTTPS GET helper
// ---------------------------------------------------------------------------

interface HttpGetResult {
  status: number;
  body: string;
}

function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<HttpGetResult> {
  return new Promise((resolve, reject) => {
    const ca = loadSystemCa() || undefined;
    const targetUrl = new URL(url);

    const secureContext = ca ? tls.createSecureContext({ ca }) : undefined;

    const options: https.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port ? parseInt(targetUrl.port, 10) : 443,
      path: targetUrl.pathname + targetUrl.search,
      method: "GET",
      headers,
      ...(secureContext ? { secureContext } : {}),
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        const encoding = Array.isArray(res.headers["content-encoding"])
          ? res.headers["content-encoding"][0]
          : res.headers["content-encoding"];
        const buf = decompressBody(rawBuf, encoding);
        resolve({
          status: res.statusCode ?? 0,
          body: buf.toString("utf8"),
        });
      });

      res.on("error", (err) => {
        if (chunks.length > 0) {
          const rawBuf = Buffer.concat(chunks);
          const encoding = Array.isArray(res.headers["content-encoding"])
            ? res.headers["content-encoding"][0]
            : res.headers["content-encoding"];
          const buf = decompressBody(rawBuf, encoding);
          resolve({
            status: res.statusCode ?? 0,
            body: buf.toString("utf8"),
          });
        } else {
          reject(err);
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error("Request timed out after 15 seconds."));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on("close", () => {
      clearTimeout(timer);
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10))
    );
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(str: string): string {
  return str.replace(/<[^>]*>/g, "");
}

/**
 * Clean text: strip tags, decode entities, collapse whitespace.
 */
function cleanText(str: string): string {
  return decodeHtmlEntities(stripTags(str)).replace(/\s+/g, " ").trim();
}

/**
 * Extract the real URL from a DuckDuckGo redirect URL.
 * Organic results: //duckduckgo.com/l/?uddg=<encoded-real-url>&...
 * Ad results:      //duckduckgo.com/l/?uddg=<encoded-duckduckgo.com/y.js...>&...
 * We decode uddg and skip anything that points back to duckduckgo.com (ads).
 */
function extractUrl(rawHref: string): string {
  if (!rawHref) return "";

  // Decode HTML entities in href first (&amp; → &)
  const href = rawHref.replace(/&amp;/g, "&");

  // Normalize scheme-relative URLs
  let normalized = href;
  if (normalized.startsWith("//")) {
    normalized = "https:" + normalized;
  }

  try {
    const u = new URL(normalized);
    const uddg = u.searchParams.get("uddg");
    if (uddg) {
      const decoded = decodeURIComponent(uddg);
      // Skip ad results — their uddg points to duckduckgo.com/y.js
      if (decoded.includes("duckduckgo.com")) {
        return "";
      }
      return decoded;
    }
    // If it's a duckduckgo.com URL without uddg, skip it
    if (u.hostname.endsWith("duckduckgo.com")) {
      return "";
    }
    return normalized;
  } catch {
    return normalized;
  }
}

/**
 * Parse DuckDuckGo HTML response to extract search results.
 */
function parseDuckDuckGoHtml(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Alternative: match by result__a links which are the title anchors
  // Pattern: find each <a class="result__a" href="...">...</a> and nearby snippet
  const titleLinkRegex =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;

  while (
    (match = titleLinkRegex.exec(html)) !== null &&
    results.length < maxResults
  ) {
    const rawHref = match[1];
    const rawTitle = match[2];

    const url = extractUrl(rawHref);
    if (!url) continue;

    const title = cleanText(rawTitle);
    if (!title) continue;

    // Look for snippet near this match position
    // Search within a window of ~2000 chars after the title link
    const searchWindow = html.slice(match.index, match.index + 2000);

    // Try result__snippet class
    let snippet = "";
    const snippetMatch = searchWindow.match(
      /<[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/
    );
    if (snippetMatch) {
      snippet = cleanText(snippetMatch[1]);
    }

    results.push({ title, url, snippet });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Search the web using DuckDuckGo HTML (no API key required).
 */
export async function webSearch(
  input: WebSearchInput
): Promise<WebSearchResult> {
  const { query, max_results, region } = webSearchInputSchema.parse(input);

  try {
    const params = new URLSearchParams({ q: query, kl: region });
    const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

    let result: HttpGetResult;
    try {
      result = await httpGet(
        url,
        {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
        },
        15_000
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        query,
        results: [],
        error: msg.includes("timed out")
          ? "Request timed out after 15 seconds"
          : `Network error: ${msg}`,
      };
    }

    if (result.status < 200 || result.status >= 300) {
      return {
        ok: false,
        query,
        results: [],
        error: `HTTP ${result.status}`,
      };
    }

    const results = parseDuckDuckGoHtml(result.body, max_results);

    return { ok: true, query, results };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, query, results: [], error };
  }
}
