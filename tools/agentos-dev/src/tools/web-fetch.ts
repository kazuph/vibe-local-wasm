/**
 * WebFetch helper — fetches a URL and returns plain-text content.
 *
 * Uses Node.js native `https`/`http` modules with a custom CA bundle to avoid
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY errors on mise/nvm-installed Node on macOS.
 * All errors are caught and returned as { ok: false } — never throws.
 */

import * as https from "node:https";
import * as http from "node:http";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { z } from "zod";

export const webFetchInputSchema = z.object({
  url: z.string().url(),
  prompt: z.string().optional(),
  max_bytes: z.number().int().positive().max(5_000_000).default(1_000_000),
});

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export type WebFetchResult = {
  ok: boolean;
  url: string;
  status?: number;
  contentType?: string;
  title?: string;
  content: string;
  truncated: boolean;
  bytes: number;
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
// HTML → plain-text helpers
// ---------------------------------------------------------------------------

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  return decodeEntities(m[1].replace(/\s+/g, " ").trim());
}

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
}

function stripTags(html: string): string {
  // Block-level tags → double newline so we preserve paragraph breaks
  const blockTags =
    /(<\/?(p|div|section|article|header|footer|h[1-6]|li|tr|blockquote|pre|br)[^>]*>)/gi;
  let text = html.replace(blockTags, "\n\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  return text;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCharCode(parseInt(dec, 10))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function normalizeWhitespace(text: string): string {
  // Collapse runs of spaces/tabs but keep newlines for paragraph breaks
  const lines = text.split(/\n/);
  const cleaned = lines.map((l) => l.replace(/[ \t]+/g, " ").trim());
  // Collapse 3+ consecutive blank lines → 2
  const result: string[] = [];
  let blankCount = 0;
  for (const line of cleaned) {
    if (line === "") {
      blankCount++;
      if (blankCount <= 2) result.push("");
    } else {
      blankCount = 0;
      result.push(line);
    }
  }
  return result.join("\n").trim();
}

function htmlToText(html: string): { title: string | undefined; text: string } {
  const title = extractTitle(html);
  let text = stripScriptsAndStyles(html);
  text = stripTags(text);
  text = decodeEntities(text);
  text = normalizeWhitespace(text);
  return { title, text };
}

// ---------------------------------------------------------------------------
// isTextLike content-type check
// ---------------------------------------------------------------------------

function isTextLike(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/xhtml") ||
    ct.includes("+xml") ||
    ct.includes("+json")
  );
}

// ---------------------------------------------------------------------------
// Decompress response body based on content-encoding
// ---------------------------------------------------------------------------

function decompressBody(
  buf: Buffer,
  encoding: string | undefined
): Buffer {
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
// Low-level HTTP request (single hop, no redirect)
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function doRequest(
  targetUrl: URL,
  timeoutMs: number,
  maxBytes: number,
  ca: string | undefined
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === "https:";

    const secureContext = ca
      ? tls.createSecureContext({ ca })
      : undefined;

    const options: https.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port
        ? parseInt(targetUrl.port, 10)
        : isHttps
        ? 443
        : 80,
      path: targetUrl.pathname + targetUrl.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; vibe-local-wasm/1.0)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      },
      ...(isHttps && secureContext ? { secureContext } : {}),
    };

    const transport = isHttps ? https : http;
    const req = (transport as typeof https).request(options, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          aborted = true;
          res.destroy(); // stop reading — we have enough
        }
      });

      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? "",
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: raw,
        });
      });

      res.on("error", (err) => {
        // If we intentionally destroyed, chunks may still be usable
        if (aborted && chunks.length > 0) {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            headers: res.headers as Record<
              string,
              string | string[] | undefined
            >,
            body: raw,
          });
        } else {
          reject(err);
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error("Request timed out after 30 seconds."));
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
// Main export
// ---------------------------------------------------------------------------

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const { url, max_bytes } = webFetchInputSchema.parse(input);

  // Validate scheme
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      url,
      content: `Invalid URL: ${url}`,
      truncated: false,
      bytes: 0,
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      url,
      content: `Unsupported URL scheme "${parsedUrl.protocol}". Only http:// and https:// are allowed.`,
      truncated: false,
      bytes: 0,
    };
  }

  // Load system CA (cached)
  const ca = loadSystemCa() || undefined;

  // Follow redirects up to 5 levels
  const MAX_REDIRECTS = 5;
  let currentUrl = parsedUrl;
  let finalUrl = url;
  let raw: RawResponse;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      raw = await doRequest(currentUrl, 30_000, max_bytes + 1, ca);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        url: finalUrl,
        content: msg.includes("timed out")
          ? "Request timed out after 30 seconds."
          : `Network error: ${msg}`,
        truncated: false,
        bytes: 0,
      };
    }

    const { status } = raw;

    // Handle redirect
    if (
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308
    ) {
      if (hop === MAX_REDIRECTS) {
        return {
          ok: false,
          url: finalUrl,
          status,
          content: `Too many redirects (>${MAX_REDIRECTS})`,
          truncated: false,
          bytes: 0,
        };
      }
      const location = Array.isArray(raw.headers["location"])
        ? raw.headers["location"][0]
        : raw.headers["location"];

      if (!location) {
        return {
          ok: false,
          url: finalUrl,
          status,
          content: `Redirect with no Location header`,
          truncated: false,
          bytes: 0,
        };
      }

      try {
        // Resolve relative redirects against current URL
        currentUrl = new URL(location, currentUrl.href);
        finalUrl = currentUrl.href;
      } catch {
        return {
          ok: false,
          url: finalUrl,
          status,
          content: `Invalid redirect Location: ${location}`,
          truncated: false,
          bytes: 0,
        };
      }
      continue;
    }

    // Non-redirect — break out of loop
    break;
  }

  // At this point raw! is set (TypeScript doesn't know, so we assert)
  const response = raw!;
  const { status, statusMessage } = response;

  // Content-encoding / type
  const rawContentEncoding = Array.isArray(
    response.headers["content-encoding"]
  )
    ? response.headers["content-encoding"][0]
    : response.headers["content-encoding"];

  const rawContentType = Array.isArray(response.headers["content-type"])
    ? response.headers["content-type"][0]
    : (response.headers["content-type"] ?? "");

  const contentType = (rawContentType ?? "").split(";")[0].trim();

  // Decompress
  let bodyBuf = decompressBody(response.body, rawContentEncoding);

  // Truncate
  let truncated = false;
  if (bodyBuf.length > max_bytes) {
    bodyBuf = bodyBuf.slice(0, max_bytes);
    truncated = true;
  }

  const bytes = bodyBuf.length;
  const rawText = bodyBuf.toString("utf8");

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      url: finalUrl,
      status,
      contentType,
      content: `HTTP ${status}: ${statusMessage || "error"}\n\n${rawText.slice(0, 500)}`,
      truncated,
      bytes,
    };
  }

  // Convert content to plain text
  let title: string | undefined;
  let content: string;

  const isHtml =
    contentType === "text/html" || contentType === "application/xhtml+xml";

  if (isHtml) {
    const converted = htmlToText(rawText);
    title = converted.title;
    content = converted.text;
  } else if (isTextLike(contentType)) {
    content = rawText;
  } else {
    // Binary or unknown content type — return a note + partial raw text
    content = `[Non-text content: ${contentType || "unknown"}]\n\n${rawText.slice(0, 200)}`;
  }

  if (truncated && isTextLike(contentType)) {
    content += `\n\n[Content truncated at ${max_bytes.toLocaleString()} bytes]`;
  }

  return {
    ok: true,
    url: finalUrl,
    status,
    contentType,
    title,
    content,
    truncated,
    bytes,
  };
}
