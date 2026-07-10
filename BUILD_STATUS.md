# Build Status

Tracks progress against the phases defined in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §16.
Update this file at the end of every work session so a fresh session can resume with zero
conversational context.

| Phase | Deliverable | Status | Notes |
|---|---|---|---|
| 0 | Repo scaffold, CLAUDE.md/AGENTS.md, OPERATIONS.md, all JSON schemas, BUILD_STATUS.md, fixtures/ | done | Smoke check passes (`.venv/bin/python tests/test_phase0_schemas.py`) |
| 1 | `status.py` + `lib/` (r2, hashing, fetch, text) | done | Smoke check passes (`.venv/bin/python tests/test_phase1_status.py`) |
| 2 | 02-archive: crawler ported from old repo + manifests + status.json | not_started | |
| 3 | 03-normalize + `lib/quotes.py` (anchoring) | not_started | |
| 4 | 04-extract: make_packets.py, prompt.md, crosscheck_prompt.md, validate.py + tiers | not_started | |
| 5 | 06-publish: catalog_schema.sql + rebuild.py | not_started | |
| 6 | 01-discover: prompt.md, packets, merge.py | not_started | |
| 7a | Review Worker + ingest.py (review.json write path) | not_started | |
| 7b | Review UI (Pages + PDF.js + highlights + Access) | not_started | |
| 8 | migration/: backfill_manifests.py + export_legacy.py | not_started | |

## Phase 0 — done

- [x] Directory scaffold created (`schemas/`, `jobs/*/`, `migration/`, `lib/`, `fixtures/`, `tests/`)
- [x] BUILD_STATUS.md (this file)
- [x] CLAUDE.md (boot file, mode-check header)
- [x] AGENTS.md (boot file, mode-check header)
- [x] OPERATIONS.md (three console rules, menu spec, transitions)
- [x] schemas/manifest.schema.json
- [x] schemas/status.schema.json
- [x] schemas/extract_metadata.schema.json
- [x] schemas/validation.schema.json
- [x] schemas/review.schema.json
- [x] jobs/01-discover/schema.json (candidates.json)
- [x] jobs/04-extract/schema.json (incidents.json, per §8)
- [x] fixtures/schema_examples/ — one example document per schema (9 cases; status.json and
      incidents.json each have two variants covering the not_found/no_url and
      zero-incident branches)
- [x] Smoke check: `tests/test_phase0_schemas.py` — all 9 example documents validate
      against their schemas (Draft 2020-12)
- [x] git init + initial commit

### Decisions made during Phase 0 (asked the user, since the plan was silent/ambiguous here)

- **validation.json shape**: the plan describes its contents in prose only (§7c anchoring +
  tier, §11 offsets for highlighting) with no worked JSON example, unlike the other six
  artifacts. Confirmed with the user: top-level `{schema_version, valid, schema_errors[]}`
  plus a per-incident array with `{index, tier, flagged_reasons[], quotes: {<quote name>:
  {anchored, similarity, offset, page_match}}, crosscheck}`, mirroring incidents.json's
  quote structure one-to-one.
- **`jsonschema` dependency**: §0 names `requests`, `beautifulsoup4`, `pypdf`/`pdfplumber`,
  `psycopg`, `boto3` but nothing for JSON Schema validation, which every artifact-writing
  script needs per invariant 3 / §4. Confirmed with the user: added `jsonschema` (pure
  Python, no transitive framework deps) to `requirements.txt`. A `.venv` was created at the
  repo root; `.venv/` and `.env` are gitignored.
- **`reference/` is gitignored**, not committed. It's a local read-only copy of the old
  repo for the Phase 2 crawler port (per the user's session instructions); it isn't part of
  the repo layout the plan specifies in §4, so it stays out of this repo's history.

## Phase 1 — done

- [x] `lib/hashing.py` — `sha256_bytes`, `short_hash` (the archive's `docs/{hash[:16]}/` dirname)
- [x] `lib/fetch.py` — `fetch_url` (retry/backoff, ported from the old repo's `helpers.py`),
      `is_pdf_response`
- [x] `lib/text.py` — `html_to_text` (BeautifulSoup, ported from old repo), `pdf_to_text`
      (pypdf, page-marked `[[page N]]`, returns `""` for scanned/no-text-layer PDFs per §7),
      `docx_to_text` (stdlib zipfile + ElementTree — no new dependency for a format
      normalize only needs to read)
- [x] `lib/r2.py` — R2 (boto3 S3-compatible) access with an `ARCHIVE_LOCAL_ROOT`
      local-filesystem fallback for tests/fixtures (decided with the user — see below).
      Import-safe with zero credentials: the boto3 client is created lazily on first real
      call, not at import time. Never raises/logs a credential *value* — `MissingEnvVar`
      carries only the variable name.
- [x] `status.py` — walks the archive (`archive/` prefix) via `lib/r2.py` and derives the
      full `status.py` JSON shape from OPERATIONS.md (scrape_year, smoke_run, discover,
      archive, normalize, extract, review, publish). `discover` reads `sources/schools.csv`
      when present (currently absent — Phase 6 creates it — so those fields are 0 until
      then). `review`/`extract` match `review.json` to incidents by re-hashing
      `incidents.json` and comparing to `extraction_ref.file_hash`, per invariant 9.
- [x] `.env.example` — every env var the project will ever need (R2, Neon, Cloudflare
      Access/Worker), placeholder values only.
- [x] `requirements.txt` — added `python-dotenv` (used only to load `.env`; no values ever
      printed/logged, per the user's session instruction).
- [x] `fixtures/mini_archive/` — a hand-made local archive (4 institutions) exercising
      every branch of `status.py`: a fully-reviewed standard-tier incident, a
      no-text-layer (scanned) PDF awaiting validation, a document pending normalize, and an
      unreviewed doc with one flagged- and one fast-tier incident. All its JSON files
      additionally validate against the Phase 0 schemas (checked manually, not yet a
      standing test).
- [x] Smoke check: `tests/test_phase1_status.py` — `status.py`'s output against
      `fixtures/mini_archive/` matches expected counts exactly; `lib/r2.py` imports and
      raises `MissingEnvVar` (not some other error) with no credentials set; basic
      `lib/hashing.py` / `lib/text.py` sanity checks.

### Decisions made during Phase 1 (asked the user, since the plan was silent here)

- **Local-vs-R2 backend for `lib/r2.py`**: the plan requires Phase 1's smoke check to run
  against a local mini archive with no live credentials, but doesn't say how scripts should
  address "the archive" in both local-test and real-R2 modes. Confirmed with the user: an
  `ARCHIVE_LOCAL_ROOT` env var, when set, makes every `lib/r2.py` function (`list_keys`,
  `get_bytes`, `put_bytes`, `exists`) operate against that local directory instead of R2,
  mirroring the R2 key layout 1:1. Unset, they lazily create a boto3 client from `R2_*` env
  vars. This is the pattern every later job (02, 03, 04, 06) should reuse rather than
  inventing its own local/R2 switch.
- **`status.py`'s `extract`/`review` semantics are provisional.** Since 01-discover and
  04-extract don't exist yet, there are no real packets/tiers to observe; the counting
  logic in `status.py` (packets lacking a current extraction, tiers pending vs. decided via
  `review.json`↔`incidents.json` hash matching) is a reasonable reading of §7–§10 but has
  not been exercised against a real `validate.py` or review app. Phase 4 (`validate.py` +
  tiers) and Phase 7a (review ingest) should treat this as a draft to confirm, not settled
  behavior — in particular, how a zero-incident report's `fast` tier is represented in
  `validation.json`'s per-incident array (there's no worked example of this yet) is still
  open.

## Next session should

Start Phase 2: 02-archive — port the crawler core from `reference/scrape.py` +
`reference/helpers.py` (frozen, read-only) using `lib/fetch.py`/`lib/hashing.py`, writing
manifests + status.json via `lib/r2.py`. Per IMPLEMENTATION_PLAN.md §16, smoke check:
fixtures crawl produces the correct archive layout with absence recorded.
