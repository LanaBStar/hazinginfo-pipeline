/**
 * index.ts -- the review app's API Worker (Phase 7b, per IMPLEMENTATION_PLAN.md
 * Section 11). Routes:
 *
 *   GET  /api/queue                          -> QueueItem[] (queue.ts, ordered by document
 *                                                then extraction_confidence ascending)
 *   GET  /api/document?doc_dir=&incident_index=  -> everything one review screen needs
 *   GET  /api/original?doc_dir=               -> the source document's bytes (PDF as-is;
 *                                                 HTML sanitized via HTMLRewriter, since
 *                                                 archived HTML comes from untrusted
 *                                                 third-party institution sites)
 *   POST /api/review  {doc_dir, review}       -> ingest.ts's ingestReview()
 *
 * The Pages static UI (../pages/) is the only intended caller. This Worker never
 * writes catalog rows (Section 11: "the app never writes catalog rows" -- it is
 * untrusted by construction) and needs no Postgres/Neon credentials at all, only its
 * own narrowly-scoped R2 binding (Section 15: reviews/ prefix only for the write
 * path -- reads span the whole archive, since the queue has to be derived from it).
 */
import { resolveReviewer, NoReviewerIdentityError } from "./access";
import { IngestError, ingestReview } from "./ingest";
import { buildQueue, loadReviewTarget } from "./queue";
import { R2Store } from "./store";
import type { ArchiveStore } from "./store";

export interface Env {
  ARCHIVE_BUCKET: R2Bucket;
  DEV_MODE?: string;
  DEV_REVIEWER?: string;
  CORS_ALLOW_ORIGIN?: string;
}

const ARCHIVE_PREFIX = "archive/";

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.CORS_ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
  };
}

function json(body: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function parseIncidentIndex(raw: string | null): number | null {
  if (raw === null || raw === "" || raw === "document" || raw === "null") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid incident_index: ${raw}`);
  return n;
}

/** HTML sanitization for the review UI's iframe. Uses the Workers runtime's built-in
 * streaming HTMLRewriter rather than a hand-rolled regex parser -- strips anything
 * that could execute or navigate, since the archived HTML is copied verbatim from an
 * arbitrary institution's website (invariant 4: we archive exactly what was fetched,
 * we don't get to assume it's safe). This is defense-in-depth: the Pages UI is also
 * expected to render it inside a `sandbox` iframe with no `allow-scripts`.
 */
class StripElement {
  element(el: Element) {
    el.remove();
  }
}
class StripDangerousAttrs {
  element(el: Element) {
    for (const [name] of [...el.attributes]) {
      if (/^on/i.test(name)) el.removeAttribute(name);
    }
    const href = el.getAttribute("href");
    if (href && /^\s*javascript:/i.test(href)) el.removeAttribute("href");
    const src = el.getAttribute("src");
    if (src && /^\s*javascript:/i.test(src)) el.removeAttribute("src");
  }
}
class StripMetaRefresh {
  element(el: Element) {
    const httpEquiv = el.getAttribute("http-equiv");
    if (httpEquiv && httpEquiv.toLowerCase() === "refresh") el.remove();
  }
}

function sanitizeHtml(response: Response): Response {
  return new HTMLRewriter()
    .on("script", new StripElement())
    .on("iframe", new StripElement())
    .on("object", new StripElement())
    .on("embed", new StripElement())
    .on("form", new StripElement())
    .on("meta", new StripMetaRefresh())
    .on("*", new StripDangerousAttrs())
    .transform(response);
}

async function handleQueue(store: ArchiveStore, env: Env): Promise<Response> {
  const items = await buildQueue(store, ARCHIVE_PREFIX);
  return json(items, 200, env);
}

async function handleDocument(store: ArchiveStore, url: URL, env: Env): Promise<Response> {
  const docDir = url.searchParams.get("doc_dir");
  if (!docDir) return json({ error: "missing doc_dir" }, 400, env);
  let incidentIndex: number | null;
  try {
    incidentIndex = parseIncidentIndex(url.searchParams.get("incident_index"));
  } catch (e) {
    return json({ error: String(e) }, 400, env);
  }
  try {
    const target = await loadReviewTarget(store, docDir, incidentIndex);
    return json({ docDir, incidentIndex, ...target }, 200, env);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 404, env);
  }
}

async function handleOriginal(bucket: R2Bucket, url: URL, env: Env): Promise<Response> {
  const docDir = url.searchParams.get("doc_dir");
  if (!docDir) return json({ error: "missing doc_dir" }, 400, env);

  const manifestObj = await bucket.get(`${docDir}/manifest.json`);
  if (!manifestObj) return json({ error: "document not found" }, 404, env);
  const manifest = JSON.parse(await manifestObj.text()) as { content_type: string };

  const isPdf = manifest.content_type === "application/pdf";
  const filename = isPdf ? "report.pdf" : "index.html";
  const obj = await bucket.get(`${docDir}/original/${filename}`);
  if (!obj) return json({ error: "original document not found" }, 404, env);

  const headers = { "Content-Type": manifest.content_type, ...corsHeaders(env) };
  const response = new Response(obj.body, { headers });
  return isPdf ? response : sanitizeHtml(response);
}

/** DEV_MODE-only: seeds the local Miniflare-simulated R2 bucket from an arbitrary set
 * of {key, content} pairs. Exists purely so the Phase 7b smoke check (and manual local
 * testing) can load a real fixture archive -- built the normal way, by running
 * 02-archive/03-normalize/04-extract against fixtures/crawl_pages/ -- into `wrangler
 * dev`'s R2 simulation, which has no other way to be pre-populated from arbitrary
 * files on disk. Gated the same way the DEV_MODE reviewer-identity stub is (src/
 * access.ts): must never be reachable on a real deploy, where DEV_MODE is unset. */
async function handleDevSeed(store: ArchiveStore, request: Request, env: Env): Promise<Response> {
  if (env.DEV_MODE !== "true") return json({ error: "dev-seed is only available with DEV_MODE=true" }, 403, env);
  let payload: { files?: Array<{ key: string; content: string }> };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, env);
  }
  const files = payload.files || [];
  for (const file of files) {
    // content is always base64 (safe for both text and binary files, e.g. PDFs).
    const binary = atob(file.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await store.putBytes(file.key, bytes);
  }
  return json({ seeded: files.length }, 200, env);
}

/** DEV_MODE-only: lists keys under a prefix -- the read-side counterpart to
 * handleDevSeed, so the smoke check can confirm a review.json actually landed in the
 * (simulated) archive after driving the UI, without needing any other way to inspect
 * Miniflare's local R2 state from outside the Worker. */
async function handleDevDump(store: ArchiveStore, url: URL, env: Env): Promise<Response> {
  if (env.DEV_MODE !== "true") return json({ error: "dev-dump is only available with DEV_MODE=true" }, 403, env);
  const prefix = url.searchParams.get("prefix") || "archive/";
  const keys = await store.listKeys(prefix);
  return json({ keys }, 200, env);
}

async function handleReviewSubmit(store: ArchiveStore, request: Request, env: Env): Promise<Response> {
  let identity;
  try {
    identity = resolveReviewer(request, env);
  } catch (e) {
    if (e instanceof NoReviewerIdentityError) return json({ error: e.message }, 401, env);
    throw e;
  }

  let payload: { doc_dir?: string; review?: Record<string, unknown> };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, env);
  }
  if (!payload.doc_dir || !payload.review) {
    return json({ error: "body must include doc_dir and review" }, 400, env);
  }

  // The client-submitted `reviewer` field is never trusted -- Phase 7a's ingest.py
  // deliberately left identity verification to "the future Worker's job" (its
  // RUNBOOK.md/docstring). This is that job: the resolved Access identity always
  // wins, so a review can never be filed under a spoofed name.
  const review = { ...payload.review, reviewer: identity.reviewer };

  try {
    const key = await ingestReview(store, payload.doc_dir, review);
    return json({ key }, 200, env);
  } catch (e) {
    if (e instanceof IngestError) return json({ error: e.message }, 422, env);
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = new R2Store(env.ARCHIVE_BUCKET);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/queue") {
        return await handleQueue(store, env);
      }
      if (request.method === "GET" && url.pathname === "/api/document") {
        return await handleDocument(store, url, env);
      }
      if (request.method === "GET" && url.pathname === "/api/original") {
        return await handleOriginal(env.ARCHIVE_BUCKET, url, env);
      }
      if (request.method === "POST" && url.pathname === "/api/review") {
        return await handleReviewSubmit(store, request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/dev-seed") {
        return await handleDevSeed(store, request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/dev-dump") {
        return await handleDevDump(store, url, env);
      }
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500, env);
    }

    return json({ error: "not found" }, 404, env);
  },
};
