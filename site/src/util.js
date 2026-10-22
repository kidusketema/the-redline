// Small helpers shared by every part of the site.

export const SLUG_RE = /^[a-z0-9]{24}$/;

// Sent on every response. Referrer-Policy keeps a secret link out of the Referer header of any link a document opens.
const BASE_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function withBase(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
// A response from JSON text that is already built (stored rows are spliced in without parsing them).
export const jsonText = (text, status = 200) =>
  new Response(text, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
export const fail = (status, error) => json({ error }, status);

export function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

export const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// 24 characters from a-z and 0-9. Bytes of 252 and up are skipped so every character is equally likely.
export function randomSlug() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 252 && out.length < 24) out += alphabet[b % 36];
    }
  }
  return out;
}

// Compares two secrets without leaking where they differ: both are hashed to the same length first.
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

export async function isOwner(request, env) {
  const key = env.PUBLISH_KEY;
  if (!key || key.length < 16) return false;
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  return !!m && (await safeEqual(m[1], key));
}

// Page writes (comments, pen marks, answers) must come from the page itself. Requests with no Origin header (curl, the CLI) pass.
export function sameOrigin(request, url, alsoOrigin) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin || origin === alsoOrigin;
}

// Reads a JSON object from the body. Returns { value } or { error, status }.
export function parseJson(text, maxBytes) {
  if (text.length > maxBytes) return { error: "That request is too large.", status: 413 };
  let value;
  try { value = JSON.parse(text); } catch { return { error: "The request body is not valid JSON.", status: 400 }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Expected a JSON object.", status: 400 };
  return { value };
}
export async function readJson(request, maxBytes) {
  return parseJson(await request.text(), maxBytes);
}

// JSON for `fields` with one more key whose value is JSON text that is already valid, so it is not parsed and re-encoded.
export function withRaw(fields, key, rawJson) {
  return JSON.stringify(fields).slice(0, -1) + "," + JSON.stringify(key) + ":" + rawJson + "}";
}

// Removes control characters (C0 and C1) except new line and tab. Text from readers is read by an AI and printed in terminals.
export function stripControls(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 9 || (c > 31 && c < 127) || c > 159) out += ch;
  }
  return out;
}

// Trims a string field and checks its length. Returns { value } or { error }.
export function cleanStr(v, name, max, { required = false } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") return { error: `${name} must be a string` };
  v = stripControls(v.replace(/\r\n?/g, "\n")).trim();
  if (required && !v) return { error: `${name} is required` };
  if (v.length > max) return { error: `${name} is too long (max ${max} characters)` };
  return { value: v };
}
