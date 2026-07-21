# 05-review

## Purpose

Write a human reviewer's decision (`review.json`) to the archive, synchronously at
decision time, per Section 10/11. This is the only place in the pipeline that writes
under `{doc_dir}/reviews/` — it is deliberately the sole gate between "a reviewer
clicked approve/fix/reject in the app" and a fact landing in the immutable archive,
since `06-publish/rebuild.py` later trusts whatever it finds there without
re-validating.

The validation/write logic exists in two places that must agree:
- `jobs/05-review/ingest.py` — the settled Python implementation (Phase 7a). Pure,
  locally-testable, no Worker/Access dependency.
- `jobs/05-review/app/worker/src/ingest.ts` — a line-for-line TypeScript port (Phase
  7b), since a Cloudflare Worker can't run Python. `ingest.py`'s docstring is the
  source of truth if the two ever appear to disagree; `worker/test/ingest.test.ts`
  exercises the same cases `tests/test_phase7a_review.py` does against `ingest.py`.

## The review app (Phase 7b)

`jobs/05-review/app/` is the actual review UI from Section 11:

```
app/
  worker/   Cloudflare Worker (API) -- TypeScript, wrangler project
  pages/    Cloudflare Pages (static UI) -- plain HTML/CSS/JS, no build step
```

**Not deployed live this phase** (confirmed with the user: local/test-only). Both
halves run entirely against Miniflare's local R2 simulation / a local static file
server — no R2, Neon, or Cloudflare Access credentials exist in `.env`. See "Real
deploy, later" below for what changes when that happens.

### Worker (`app/worker/`)

- `src/hashing.ts` — port of `lib/hashing.py`. (`src/quotes.ts`, the fuzzy-match
  anchoring port, was retired along with the rest of the tier/anchoring system — see
  below.)
- `src/ingest.ts` — the TypeScript port described above.
- `src/queue.ts` — builds the reviewable queue by walking the archive directly
  (mirrors `status.py`'s `walk_archive`), **not** from Postgres: `catalog_schema.sql`'s
  `Incidents`/`Organizations` tables only ever hold already-reviewed (promoted) rows
  (`06-publish/rebuild.py`), so there is no "pending" projection to read a queue from
  there. This means the review app needs only an R2 binding, no Neon/Postgres
  credentials at all. Ordered by document, then by `extraction_confidence` ascending
  within a document (lowest-confidence items surfaced first) — no more tiers.
- `src/access.ts` — reviewer identity from the `Cf-Access-Jwt-Assertion` header
  (decoded, not signature-verified — Access itself is expected to have already
  verified it at the edge before a real deploy). `DEV_MODE=true` (set in
  `wrangler.toml` for local dev) falls back to a fixed `DEV_REVIEWER` identity so
  local testing doesn't need a real Access login. **Must never be `true` on a live
  deploy.**
- `src/index.ts` — routes: `GET /api/queue`, `GET /api/document`, `GET /api/original`
  (PDF as-is; HTML sanitized via `HTMLRewriter`, since archived HTML comes from an
  untrusted third-party site), `POST /api/review`. Also `POST /api/dev-seed` / `GET
  /api/dev-dump` (DEV_MODE-only) — let a local archive be loaded into / inspected from
  Miniflare's R2 simulation for testing, since there's no other way to pre-populate it
  from files on disk.
- The client-submitted `reviewer` field on `POST /api/review` is never trusted: the
  Worker overwrites it with the resolved Access/DEV_MODE identity before calling
  `ingestReview()`.

Run locally: `npm --prefix jobs/05-review/app/worker run dev` (or via
`.claude/launch.json`'s `review-worker` config). Run its unit tests: `npm --prefix
jobs/05-review/app/worker test`.

### Pages (`app/pages/`)

Static HTML/JS/CSS, no bundler — `config.js` holds the one thing that changes between
environments (`workerBaseUrl`). One incident (or, for a zero-incident report, the
whole document) per screen:

- Original document is the ground truth: PDF.js canvas for PDFs, a sanitized HTML
  document (fetched and injected via `srcdoc` with `sandbox="allow-same-origin"` and
  no `allow-scripts`, so nothing in it can execute) for HTML. Raw text fields
  (`description_raw`, `findings_raw`, `sanctions_raw`, `zero_incidents_statement`) are
  pre-highlighted by best-effort text search — cosmetic only. There is no
  page-anchored quote/offset in v3.0 (that whole mechanism, and `lib/quotes.py`/
  `src/quotes.ts`, was retired with the tier system); `validate.py` only checks schema
  conformance now, so highlighting here never claims to be authoritative.
- Extracted text is shown collapsed, labeled navigation-only — never the surface a
  reviewer compares claims against.
- Each incident screen also surfaces its `extraction_confidence` (as a badge) and any
  structured `flags[]` the AI reported, plus a standalone **organization review**
  panel (`decision` approved/corrected/rejected + `corrected_organization_type`) —
  independent of the incident's own decision, since organization matching/promotion is
  handled separately by `06-publish/rebuild.py`.
- Keyboard-driven: `A` approve, `F` fix (opens a correction form), `X` reject (opens a
  reason picker), `←`/`→` PDF page, `Esc` close a form/the help panel, `?` toggle the
  shortcut legend. The old `E` escalate shortcut is gone — decision is a single, final
  call in v3.0.
- Scanned-PDF (empty `extracted/text.txt`) view: PDF.js still renders the page's
  visual content regardless of text layer, so the "page image beside the fields"
  requirement from Section 11 falls out of the same PDF.js canvas — no separate
  page-image pipeline needed. No highlight overlay is drawn (nothing to search text
  against), and a note says so.

Run locally: `python3 -m http.server 8788 --directory jobs/05-review/app/pages` (or
via `.claude/launch.json`'s `review-pages` config) with `review-worker` also running.

### v3.0 shape of review.json / ingest.py / ingest.ts

- `extraction_ref.incident_index` may be `null`, meaning "the whole document" — the
  only way to represent approving/rejecting a zero-incident report, which has no
  `incidents[]` to index. Filename token is the literal string `document` in place of
  the index (`{doc_dir}/reviews/document_{reviewer-slug}_{ts}.review.json`). A
  document-level review can never resolve to `decision: "corrected"` (no per-field
  correction vocabulary exists for the document object) — rejected, no write; a
  reviewer should reject a bad zero-incident claim instead, sending it back for
  re-extraction.
- `decision` is `approved` / `rejected` / `corrected` only — no `escalated`, no
  `second_review`. A single reviewer makes the final call, informed by the AI's own
  `extraction_confidence` and `flags[]` rather than a tier/dual-review system.
- `corrections` is a list of per-field entries (`field_name`, `original_value`,
  `corrected_value`, `correction_type[]`) — one per changed field, matching
  `Staging_incident_corrections`' grain — rather than the old dotted-path blob.
  `field_name` must be one of `ingest.py`'s `CORRECTABLE_FIELDS` (mirrored exactly in
  `ingest.ts` and again in `06-publish/rebuild.py`'s own whitelist).
- `organization_review` (`{decision, corrected_organization_type} | null`) is new and
  independent of the incident's own `decision` — it must be `null` for a document-level
  review (no organization to review) and may be set for any incident-level review.

## Preconditions

- The document at `doc_dir` has gone through 04-extract: at least one
  `{doc_dir}/ai/extract_v{N}/incidents.json` exists. `extracted/text.txt` is no longer
  required by `ingest_review()` itself in v3.0 (there's nothing left to re-anchor
  against) — the Pages UI still reads it for the navigation-only text panel and
  best-effort highlighting.
- No write credentials are required — set `ARCHIVE_LOCAL_ROOT` for `ingest.py` /
  Python tests, or let the Worker run against Miniflare's local R2 simulation (the
  default for `wrangler dev`) for the app.
- The caller already knows `doc_dir` — review.json itself only carries
  `extraction_ref.file_hash` + `incident_index`, not which document that extraction
  belongs to. The review app gets it from the queue (`GET /api/queue`'s `docDir`,
  which is the archive path itself — the app never queries Postgres, see `queue.ts`
  above).

## Steps

**Via the app (real usage):** open the Pages UI, work the queue in the order it's
given (by document, then by `extraction_confidence` ascending — lowest-confidence
items first). Each decision is one `POST /api/review` call the Worker validates via
`ingestReview()` before writing.

**Manually / for a single document:** `python jobs/05-review/ingest.py --doc-dir
<archive path> --review <path to a review.json file>` — or call
`ingest_review(doc_dir, review_json)` directly.

In both paths, the validating logic does, in order, never partially writing:
- Validates the review against `schemas/review.schema.json`.
- Confirms `extraction_ref.file_hash` matches the sha256 of some
  `ai/extract_v{N}/incidents.json` under `doc_dir` (searches every version, not just
  the current one — invariant 9), and that `extraction_ref.incident_index` is either
  in range for that extraction's `incidents[]`, or `null` for a genuine zero-incident
  extraction.
- If `decision == "corrected"`: confirms `incident_index` is not null (a
  document-level review can never be `corrected`) and every correction's `field_name`
  is one of `CORRECTABLE_FIELDS`.
- If `organization_review` is present: confirms `incident_index` is not null.
- Writes to `{doc_dir}/reviews/{incident_index}_{reviewer-slug}_{ts}.review.json` (or
  `.../document_{reviewer-slug}_{ts}.review.json` for a document-level review).

## Postconditions

- A validated, hash-pinned `review.json` exists under `{doc_dir}/reviews/`, ready for
  `06-publish/rebuild.py` to pick up on the next rebuild.
- The archive is never overwritten: `decision` is a single, final call, so each
  `(file_hash, incident_index)` target is reviewed exactly once and then drops out of
  `queue.ts`'s output — there's no dual-review resolution to reconcile.

## Failure modes

- Any of schema validation, hash-pinning, or range-checking failing raises
  `IngestError` (Python) / rejects with HTTP 422 (Worker) and writes nothing — a
  rejected review never partially lands in the archive. The Pages UI surfaces the
  error message inline so the reviewer can fix the correction and resubmit.
- `POST /api/review` with no Access JWT and `DEV_MODE` unset returns 401 — this is the
  guard that must hold before any real deploy adds a live Cloudflare Access
  application in front of the Worker's route.

## Real deploy, later

Confirmed with the user this phase stays local/test-only. Going live needs, at
minimum: a real `R2_*` credential set scoped to `reviews/` writes (Section 15) bound
into `wrangler.toml`, a Cloudflare Access application gating the Worker's route (with
`DEV_MODE` removed from its vars), and `config.js`'s `workerBaseUrl` pointed at the
deployed Worker. None of that is code — it's Cloudflare dashboard/wrangler
configuration on top of what's already built here.
