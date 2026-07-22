# HazingInfo.org CHTR Archival Pipeline — architecture reference

This file is for anyone (human or agent) writing code in this repo. It describes the
system as currently implemented — not a plan, not a build log. For running the pipeline
day-to-day, see [OPERATIONS.md](OPERATIONS.md). For the exact Postgres field list, see
[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md). For a human-facing overview, see
[README.md](README.md).

The pipeline finds each tracked institution's Campus Hazing Transparency Report (CHTR),
archives the original document permanently, extracts structured incident data with AI,
routes every extraction through human review, and publishes approved results to a
Postgres catalog. The core pipeline (R2, Neon, Airtable) is credentialed and can run
against production data; the review app's Cloudflare Worker deploy is not live yet —
see "Open items" at the end.

## Core principles

These hold across every job in the pipeline; if you're adding code, match them rather
than inventing a new pattern.

1. **R2 (object storage) is the sole source of truth.** Every fact the pipeline has ever
   found or decided is a JSON file in the archive. Postgres (`jobs/06-publish/`) is a
   disposable projection — always fully dropped and rebuilt from the archive, never
   incrementally updated. Nothing is ever "true" only in Postgres.
2. **Every artifact-writing script validates against a JSON Schema before writing**
   (`schemas/*.json` and each job's own `schema.json`). Invalid AI output is still
   archived (marked `valid: false`), never silently discarded and never blocked from
   being visible to a human.
3. **The AI/agent never writes to the archive directly.** It fills in a packet
   (`tasks/.../prompt.md` → some output file); only a plain, validating Python script
   (`make_packets.py`'s counterpart, e.g. `validate.py`, `merge.py`, `ingest.py`) commits
   it to R2. This is why every job directory has a script *and* a prompt, not just one.
4. **A human decision must be written to a file a script reads.** A chat answer is not a
   decision — see `OPERATIONS.md`'s "decisions become files."
5. **Absence is data.** `status.json` is written even when nothing was found
   (`no_url`/`not_found`); `data_check.json` is written every cycle for every processed
   institution, confirmed URL or not. Never skip writing a record just because the
   outcome was negative.
6. **Pipeline state is always derived by walking the archive fresh, never cached.**
   `status.py`, the review app's `queue.ts`, and `rebuild.py`'s flag recomputation all
   re-derive their answer from R2 on every call rather than reading a stored status
   field. A corollary: review flags are recomputed from final (post-correction) values
   on every rebuild, not carried over as stateful history — `resolved_at` columns that
   would track that history are always `NULL`.
7. **IDs are content-derived hashes, never auto-increment.** Every primary key across the
   archive and the catalog is `short_hash(sha256(...))` (16 hex chars, `lib/hashing.py`)
   computed from stable inputs — e.g. an incident's `incident_id` is hashed from the
   *original, uncorrected* extraction, so a reviewer fixing a typo never changes its
   public ID. This makes rebuilds idempotent: an unchanged archive always produces a
   byte-identical catalog. The one accepted exception is `institution.created_at`, stamped
   at rebuild wall-clock time since `schools.csv` carries no "first tracked" timestamp.
8. **Every job is resumable and safe to re-run.** Each script skips work it can already
   see done in the archive (a `status.json` that exists, a `text.txt` that exists, an
   `ai/extract_v{N}/` that exists). A single item's failure (one institution's crawl, one
   packet's validation) is caught and logged, never aborts the whole run.
9. **Local dev and real R2 share one code path.** `lib/r2.py`'s `ARCHIVE_LOCAL_ROOT` env
   var makes every archive read/write hit a local directory (mirroring R2's key layout
   exactly) instead of a real bucket. Unset, it lazily creates a boto3 client from `R2_*`
   env vars. Every job that touches the archive uses this, never its own local/R2 switch.
   Similarly, every archive-writing job accepts a `--prefix` flag (default `archive`) so
   the fixtures/smoke run can target a sandboxed `smoke/` prefix, never mixed with real
   data.

## Repo layout

```
sources/schools.csv        tracked institution roster (unitid, name, state, chtr_url, url_status, evidence)
jobs/01-discover/          find + confirm each institution's CHTR URL
jobs/02-archive/           crawl + permanently store original documents in R2
jobs/03-normalize/         plain-text extraction from stored documents
jobs/04-extract/           AI extraction of structured incident data
jobs/05-review/            human review — ingest.py (Python) + app/ (Cloudflare Worker + Pages)
jobs/06-publish/           rebuild the Postgres catalog from the archive
lib/                       shared helpers — see "lib/" below
schemas/                   JSON Schemas for every cross-job artifact
fixtures/                  synthetic data for local dev + the test suite
tests/                     one test file per job/phase, runs the real pipeline against fixtures/
reference/                 frozen, read-only mirror of the predecessor repo (git-ignored,
                            local-only — source material for the 02-archive crawler port;
                            never modify it)
status.py                  derives full pipeline state by walking the archive
DATABASE_SCHEMA.md         authoritative field-by-field reference for the Postgres catalog
```

Every `jobs/{NN}-{name}/RUNBOOK.md` documents that job's purpose, preconditions, exact
steps, postconditions, and failure modes — read it before changing that job's behavior.

### `lib/`

- `r2.py` — archive access (`list_keys`, `get_bytes`, `put_bytes`, `exists`); local vs.
  real R2 dispatch (principle 9). Import-safe with zero credentials — the boto3 client is
  created lazily on first real call, and `MissingEnvVar` never carries a credential value.
- `hashing.py` — `sha256_bytes`, `short_hash` — the ID scheme (principle 7).
- `fetch.py` — retry/backoff HTTP fetch, shared by 01-discover and 02-archive, ported
  from the predecessor repo.
- `text.py` — `pdf_to_text` (page-marked `[[page N]]`, `""` for scanned/no-text-layer
  PDFs — no OCR), `html_to_text`, `docx_to_text`.
- `fingerprint.py` — `content_fingerprint` for the ledger: strips boilerplate/date tokens
  before hashing so an institution's annual re-post of an unchanged report (with only an
  embedded date differing) registers as unchanged.

## Data flow

### `sources/schools.csv`

The ~1,484-row roster: `unitid` (IPEDS, natural key), `name`, `state` (currently blank
for every row — no IPEDS backfill has happened), `chtr_url`, `url_status`
(blank/`pending`/`confirmed`/`no_url`), `evidence`. Only `01-discover/merge.py` writes to
it; it asserts the row set (by `unitid`) is unchanged before every write — rows are never
added or removed by the pipeline.

### 01-discover

Agent searches for each institution's CHTR URL (`make_batches.py` slices unbatched rows
into `tasks/discover/batch_{NNN}/`, agent writes `candidates.json` per `prompt.md`), the
operator confirms/rejects each candidate via chat (written to `decisions.json` — the
chat answer itself is not the decision, principle 4), and `merge.py` validates and writes
confirmed URLs into `schools.csv`. A rejected candidate's `url_status` resets to blank,
making it eligible for the next batching pass. `import_airtable.py` then cross-checks
every confirmed URL against an existing Airtable schools-registry base's `Transparency
Report` field, writing `tasks/discover/airtable_cross_check.json` — a mismatch is
surfaced for the operator, and neither source is ever silently overwritten.

### 02-archive

`run.py` crawls every institution with a confirmed URL (breadth-first, depth ≤ 2, ~30
fetch budget, same-domain priority, every PDF on a hazing-signal page followed — no
relevance judgment happens here, that's 04-extract's `is_chtr`). For each document
stored, writes `manifest.json`; for each institution-year, writes `status.json`
(`published`/`not_found`/`no_url` — `published_zero` is reserved, never written here,
since it requires reading document content). Also writes a `ledger/{url_hash16}.json`
entry per distinct URL ever seen (updated in place across years, `first_seen_date`
preserved) and a `data_check.json` per institution per cycle, and bookends each batch run
with a `pipeline_runs/{run_id}.json` record at the archive root. Deduplicates unchanged
documents across scrape years by content hash — an unchanged document is never
re-fetched-and-stored twice.

### 03-normalize

`run.py` writes `extracted/text.txt` for every document lacking one, dispatching on
`manifest.json`'s `content_type` to the right `lib/text.py` function. Always writes the
file, even when extraction yields `""` (a scanned PDF with no text layer) — absence is
data (principle 5), and downstream extraction/review treat empty text as a real signal
rather than a missing file.

### 04-extract

`make_packets.py` builds one task packet per normalized document lacking a current
extraction, under `tasks/extract/{unitid}_{hash16}/` (`prompt.md`, the original
document, `text.txt`, `schema.json`, a `metadata.json` stub carrying `doc_dir` +
`target_version` so the write-back path is unambiguous). The agent follows `prompt.md`
and writes `incidents.json`: raw + normalized + precision fields per incident, an
organization proposal (`organization_name_raw/normalized`, `organization_type`),
`determination_status`, independent `alcohol_involved`/`drugs_involved` enums, and — per
incident — a self-reported `extraction_confidence` and a structured `flags[]` array.
`validate.py` strictly validates against `schema.json` (unknown fields rejected) and
archives `incidents.json` + `metadata.json` + `validation.json`
(`{schema_version, valid, schema_errors}`) to `{doc_dir}/ai/extract_v{N}/` — invalid
output is archived too, never discarded. Organization matching and cross-year status
detection are **not** this job's concern; both are derived by `06-publish/rebuild.py` at
publish time (principle 6).

### 05-review

A human approves, corrects, or rejects each proposed incident (and, independently, its
organization proposal) via a web app. The validating write path exists in two places
that must agree: `jobs/05-review/ingest.py` (Python, the source of truth) and
`jobs/05-review/app/worker/src/ingest.ts` (a line-for-line TypeScript port, since a
Cloudflare Worker can't run Python). Both, in order, never partially writing:

1. Validate the review against `schemas/review.schema.json`.
2. Confirm `extraction_ref.file_hash` matches the sha256 of some
   `ai/extract_v{N}/incidents.json` under `doc_dir` (searches every version, so a review
   against an older extraction still pins correctly), and `incident_index` is in range
   (or `null`, meaning "the whole document" — the only way to review a genuine
   zero-incident report, which has no `incidents[]`).
3. If `decision == "corrected"`: `incident_index` must not be `null`, and every
   correction's `field_name` must be one of `CORRECTABLE_FIELDS` (mirrored exactly across
   `ingest.py`, `ingest.ts`, and `rebuild.py`'s own whitelist).
4. If `organization_review` is present: `incident_index` must not be `null`.
5. Write to `{doc_dir}/reviews/{incident_index}_{reviewer-slug}_{ts}.review.json` (token
   `document` in place of the index for a document-level review).

`decision` is `approved` / `rejected` / `corrected` only — one reviewer, one final call,
informed by the AI's own `extraction_confidence`/`flags[]` rather than tiers or a
second-reviewer/escalation mechanism (there is neither in this design). Each
`(file_hash, incident_index)` target is reviewed exactly once.

**The app** (`jobs/05-review/app/`): a Cloudflare Worker (`worker/`, TypeScript) plus a
static Pages UI (`pages/`, plain HTML/CSS/JS, no build step). The Worker's `queue.ts`
builds the reviewable queue by walking the archive directly — **never Postgres**, since
`Incidents`/`Organizations` only ever hold already-*promoted* rows, so there is no
pending-item projection to read there. This means the app needs only an R2 binding, no
Neon credentials. Queue order: by document, then `extraction_confidence` ascending
(lowest confidence first; a document-level target sorts first via `?? -Infinity`).
`access.ts` resolves reviewer identity from `Cf-Access-Jwt-Assertion` (decoded, not
signature-verified — real Cloudflare Access is expected to have verified it at the edge);
`DEV_MODE` falls back to a fixed identity for local dev and **must never be true on a
live deploy**. `index.ts` never trusts a client-submitted `reviewer` field — it overwrites
it with the resolved identity before calling `ingestReview()`. `/api/original` sanitizes
archived HTML via `HTMLRewriter` (untrusted third-party content); the Pages UI further
sandboxes it in a scriptless `srcdoc` iframe. PDFs render via PDF.js. Local dev:
`npm --prefix jobs/05-review/app/worker run dev` (port 8787) +
`python3 -m http.server 8788 --directory jobs/05-review/app/pages` (also in
`.claude/launch.json` as `review-worker`/`review-pages`).

### 06-publish

`rebuild.py`, inside one transaction: drops and recreates both Postgres schemas from
`catalog_schema.sql`, then walks the *entire* archive once, in FK-dependency order, and
repopulates all 15 tables. Never incremental (principle 1) — run it after every review
batch. See "Catalog" below for the schema and promotion rules, and
`jobs/06-publish/RUNBOOK.md` for the full per-table walk-through.

## Archive layout (R2 key shape)

```
{prefix}/                              "archive" (real) or "smoke" (sandboxed fixtures run)
  pipeline_runs/{run_id}.json          archive-root, not institution-scoped
  catalog/last_rebuild.json            written by 06-publish, read by status.py
  {unitid}_{slug}/
    ledger/{url_hash16}.json           one per distinct URL ever seen, updated in place
                                        (the one archive file exempt from the immutability
                                        rule below — it's dedup bookkeeping, not content)
    {scrape_year}/
      status.json                     institution-year status — always written
      data_check.json                 always written per cycle
      docs/{hash16}/
        manifest.json
        original/...                  raw fetched bytes, immutable
        extracted/text.txt            written by 03-normalize (possibly "")
        ai/extract_v{N}/
          incidents.json
          metadata.json
          validation.json
        reviews/
          {incident_index|document}_{reviewer-slug}_{ts}.review.json
```

Nothing under `docs/{hash16}/` is ever mutated after being written — a re-extraction adds
a new `extract_v{N}/`, a correction adds a new `reviews/*.review.json`; nothing is
overwritten in place.

## Catalog (Postgres, `jobs/06-publish/`)

Two schemas, 15 tables total, defined in `catalog_schema.sql` (topologically ordered by
FK dependency — `staging` tables that `public.incidents` references must exist first,
and `public.incidents` must exist before `staging_incident_possible_matches` can
reference it back). `DATABASE_SCHEMA.md` is the authoritative field-by-field reference;
this section covers the *behavior*.

- **`staging`**: `staging_incidents`, `staging_organizations`,
  `staging_incident_possible_matches`, `staging_incident_review_flags`,
  `staging_incident_corrections`. Holds every AI-proposed incident/organization
  regardless of review status.
- **`public`**: `institution`, `pipeline_runs`, `data_checks`, `ledger`, `artifacts`,
  `incidents`, `incident_organizations`, `incident_dates`, `incident_status_history`,
  `organizations`. Holds only what an `Approved` review decision promoted.

`rebuild.py` walks doc dirs in a deterministic `(unitid, scrape_year, fetched_at)` order
so an earlier report's incidents are staged/promoted before a later re-scrape of the same
institution can match against them:

- Every `incidents[]` entry becomes a `staging_incidents` row; a matching
  `reviews/*.review.json` (by `file_hash` + `incident_index`) sets
  `human_review_status` (`approved`/`corrected` → `Approved`, `rejected` → `Rejected`,
  no match → `Pending review`). A `corrected` review's field corrections are applied to a
  copy before storage — `incident_id` is still computed from the *original* raw
  extraction (principle 7), and every applied correction is logged to
  `staging_incident_corrections`.
- An incident naming an organization gets a `staging_organizations` row, matched against
  already-*approved* organizations seen earlier in the same rebuild by a deterministic
  lowercase/trim/punctuation-stripped comparison key.
- `staging_incident_review_flags` are recomputed fresh every rebuild (principle 6):
  `Required field missing` / `Low extraction confidence` (<0.7) mechanically, from final
  field values; the remaining flag types carry forward from the AI's own `flags[]` unless
  the reviewer's correction touched that exact field.
- For an `Approved` incident: looked up against already-*public* incidents for the same
  institution by `investigation_end_date` (primary) or `(organization key,
  incident_start_normalized)` (secondary, catches `Pending` incidents with no end date
  yet). A hit records a `staging_incident_possible_matches` row
  (`match_basis`: `Duplicate match` if `determination_status` is unchanged, else
  `Status update to existing incident`). A status update **updates the existing
  `incidents` row in place** and inserts an `incident_status_history` row — the public
  row's `staging_incident_id` stays frozen at whichever extraction *first* promoted it;
  the resolving extraction is tracked only via
  `incident_status_history.staging_incident_id`.

Failure handling matches principle 8: a single incident's staging/promotion failure is
logged and skipped, not an abort; any failure before the final commit rolls back the
whole run (a crashed rebuild is safe to just re-run).

## Conventions when adding code

- New archive-writing script → give it a schema in `schemas/` (or the job's own
  `schema.json` if it's job-local), validate before every write, accept `--prefix`.
- New job-local script that touches the archive → use `lib/r2.py`, never a bespoke
  local/R2 branch.
- New ID → `short_hash(sha256(...))` of stable, correction-independent inputs. Never a
  DB-assigned serial.
- Extending `jobs/06-publish/`'s `CORRECTABLE_FIELDS` → update `ingest.py`, `ingest.ts`,
  and `rebuild.py`'s whitelist together; they're independently maintained, not imported
  from one shared source.
- New test → follow the existing pattern: build a real (small) archive from `fixtures/`
  by actually running the upstream jobs, not by hand-authoring every intermediate file.

## Open items

- `Artifacts.pipeline_run_id` is approximated (the run whose time window brackets the
  artifact's `fetched_at`), not stored directly — `manifest.json` has no
  `pipeline_run_id` field of its own, unlike `data_check.json`. Matters only if tracing a
  bad extraction back to its exact producing run ever becomes necessary.
- The review app has never been deployed live: no real R2 credentials scoped to
  `reviews/`, no Cloudflare Access application, `config.js` still points at nothing.
  Nothing in the pipeline blocks this — it's a credentials/deploy step only.
