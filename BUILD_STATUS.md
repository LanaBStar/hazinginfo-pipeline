# Build Status

Tracks progress against the phases defined in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §16.
Update this file at the end of every work session so a fresh session can resume with zero
conversational context.

| Phase | Deliverable | Status | Notes |
|---|---|---|---|
| 0 | Repo scaffold, CLAUDE.md/AGENTS.md, OPERATIONS.md, all JSON schemas, BUILD_STATUS.md, fixtures/ | done | Smoke check passes (`.venv/bin/python tests/test_phase0_schemas.py`) |
| 1 | `status.py` + `lib/` (r2, hashing, fetch, text) | done | Smoke check passes (`.venv/bin/python tests/test_phase1_status.py`) |
| 2 | 02-archive: crawler ported from old repo + manifests + status.json | done | Smoke check passes (`.venv/bin/python tests/test_phase2_archive.py`) |
| 3 | 03-normalize + `lib/quotes.py` (anchoring) | done | Smoke check passes (`.venv/bin/python tests/test_phase3_normalize.py`) |
| 4 | 04-extract: make_packets.py, prompt.md, crosscheck_prompt.md, validate.py + tiers | done | Smoke check passes (`.venv/bin/python tests/test_phase4_extract.py`) |
| 5 | 06-publish: catalog_schema.sql + rebuild.py | done | Smoke check passes (`.venv/bin/python tests/test_phase5_publish.py`) |
| 6 | 01-discover: prompt.md, packets, merge.py | done | Smoke check passes (`.venv/bin/python tests/test_phase6_discover.py`) |
| 7a | Review Worker + ingest.py (review.json write path) | done | Smoke check passes (`.venv/bin/python tests/test_phase7a_review.py`) |
| 7b | Review UI (Pages + PDF.js + highlights + Access) | done | Smoke check passes (`.venv/bin/python tests/test_phase7b_review_app.py`; `npm --prefix jobs/05-review/app/worker test`) |
| 9 | v3.0 migration docs: IMPLEMENTATION_PLAN.md, OPERATIONS.md, BUILD_STATUS.md rewritten for the new CHTR Data Dictionary schema | done | No smoke check (pure documentation) |
| 10 | Schemas: retire anchoring shape, reshape extract/review schemas, add ledger/data_check/pipeline_run | done | Smoke check passes (`.venv/bin/python tests/test_phase0_schemas.py`, now 12 cases) |
| 11 | 02-archive: Ledger fingerprinting, Data_checks, Pipeline-runs | done | Smoke check passes (`.venv/bin/python tests/test_phase2_archive.py`, extended) |
| 12 | 01-discover: Airtable cross-check step | done | Smoke check passes (`.venv/bin/python tests/test_phase12_discover_airtable.py`) |
| 13 | 03-normalize compatibility confirmation | done | No code changes needed; `tests/test_phase3_normalize.py` re-run clean |
| 14 | 04-extract: drop anchoring/tiers, new incidents.json shape (organization matching/cross-year detection moved to Phase 16 — see notes) | done | Smoke check passes (`.venv/bin/python tests/test_phase4_extract.py`, rewritten in place) |
| 15 | 05-review: per-field corrections + flags, drop tiers/escalation, organization review screen | done | Smoke check passes (`.venv/bin/python tests/test_phase7a_review.py` + `npm --prefix jobs/05-review/app/worker test`) |
| 16 | 06-publish: new catalog_schema.sql (15 tables, 2 schemas) + rebuild.py | done | Sanity-checked against a scratch local Postgres DB (see Phase 16 notes) — the official smoke test rewrite is Phase 17 |
| 17 | Fixtures + full smoke re-run against the new schema | not started | |

## Phase 0 — done

- [x] Directory scaffold created (`schemas/`, `jobs/*/`, `lib/`, `fixtures/`, `tests/`) —
      a `migration/` directory was also scaffolded here for a since-removed Phase 8; see
      "Phase 8 (removed)" below.
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

## Phase 2 — done

- [x] `jobs/02-archive/run.py` — crawl core ported nearly 1:1 from `reference/scrape.py` +
      `reference/helpers.py` (keyword heuristics, BFS, depth <= 2, ~30-fetch budget,
      same-domain priority, all PDFs on hazing-signal pages followed). Storage layer
      replaced: writes `manifest.json` (per document, validated against
      `schemas/manifest.schema.json`) and `status.json` (per institution-year, validated
      against `schemas/status.schema.json`) via `lib/r2.py` instead of Postgres rows.
      Reads `sources/schools.csv` (unitid, name, state, chtr_url, url_status, evidence);
      warns and returns cleanly if that file doesn't exist yet (01-discover/Phase 6 hasn't
      run). Resumable: skips any institution whose current-year `status.json` already
      exists. A single institution's fetch/crawl exception is caught and recorded as
      `not_found` rather than aborting the whole run.
- [x] `jobs/02-archive/RUNBOOK.md` — purpose, preconditions, steps, postconditions,
      failure modes.
- [x] `fixtures/crawl_pages/` — new fixture set (distinct unitids from Phase 1's
      `fixtures/mini_archive/`, which is a separate already-processed archive snapshot):
      North Ridge College (HTML CHTR, 2 incidents, direct hazing signal on the source
      page), Eastview University (HTML index page with hazing signal linking to a real
      CHTR PDF **and** a non-CHTR decoy PDF — both get archived, since 02-archive follows
      every PDF on a hazing-signal page and defers relevance judgment to 04-extract's
      `is_chtr`), Westfield Institute (a PDF source URL with no extractable text layer —
      the "scanned" case), Centerville Tech (no hazing signal anywhere — exercises
      `not_found`), and No Report Academy (`url_status=no_url` — exercises `no_url` with
      no fetch at all). `schools_template.csv` uses a `{BASE_URL}` placeholder the test
      fills in with the local test server's actual port. PDFs are minimal hand-built
      single-page PDFs (no PDF-writing library is in `requirements.txt`); verified against
      `lib/text.pdf_to_text` before use (real text extracts; the scanned one yields `""`).
- [x] Smoke check: `tests/test_phase2_archive.py` — starts a local HTTP server over
      `fixtures/crawl_pages/`, runs `run.py` against a generated `schools.csv`, and
      asserts: correct archive layout + absence recorded (3 published / 1 not_found / 1
      no_url); every written `manifest.json`/`status.json` validates against its schema;
      a second run against the same year is fully resumable with **zero** HTTP fetches
      (verified via a call-counting wrapper, not just a results check); a third run
      against a new scrape year re-crawls (network happens) but dedupes unchanged
      documents — same content hashes, no new `docs/` directory created under the new
      year.

### Decisions made during Phase 2 (asked the user, since the plan was silent/ambiguous here)

- **status.json's 4-way enum, and what triggers each value**: §7/§6 don't say how
  `no_url` vs. `not_found` are distinguished, or when (if ever) 02-archive writes
  `published_zero`. Confirmed with the user: `run.py` only ever writes three of the four
  values — `no_url` (institution's `schools.csv` row has `url_status=no_url`, no fetch
  attempted at all), `not_found` (a confirmed URL existed but the crawl stored zero
  documents — folds the old repo's single `published_empty` outcome, covering both fetch
  failure and no-hazing-signal-anywhere, into one status), and `published` (>=1 document
  archived, whether newly stored or deduped from a prior year). `published_zero` is never
  written by 02-archive: it requires reading document content for an explicit
  zero-incident statement, which is only knowable at 04-extract time, and rewriting
  `status.json` later would violate the archive's append-once/immutable invariant — so
  this status value is reserved for future derivation elsewhere, not touched by this job.
- **Same-origin asset fetching for HTML pages (§7's "best-effort" clause)**: confirmed
  with the user to defer this to a later phase rather than implement it now — the plan
  gives no detail on scope/depth (which tags count as "assets needed to render", how deep
  to follow, whether to rewrite the stored HTML), and Phase 2's archived `index.html`
  files currently have no `assets/` sibling directory. Revisit before relying on the
  review app (`05-review`) to render archived HTML with full fidelity.

### Post-Phase-7b fix: `jobs/02-archive/run.py` gained a `--prefix` flag

Found while preparing the operator-console handoff (grounding it in real repo state
before writing the prompt, not just describing intent): `02-archive/run.py` had no
`--prefix` flag, unlike its three siblings (`03-normalize/run.py`,
`04-extract/make_packets.py`, `06-publish/rebuild.py`), which all support one. It always
wrote to a hardcoded `ARCHIVE_PREFIX = "archive"`. That meant OPERATIONS.md's mandatory
first operator-console step — the fixtures smoke run into a sandboxed `smoke/` prefix
(§14, "never mixed with real data") — could not actually work: 02-archive would write
straight into the real `archive/` prefix instead.

Fixed by threading a `prefix: str = ARCHIVE_PREFIX` parameter through
`run`/`process_institution`/`crawl_institution`/`_crawl`/`store_document`/`write_status`/
`_existing_hashes` (mirroring `03-normalize`'s exact pattern) and adding `--prefix` to
`main()`'s argparse. Default behavior (writing to `archive/`) is unchanged — every prior
phase's test still passes with no changes to its own calls. Added `tests/
test_phase2_archive.py`'s "run 4": a real crawl with `prefix="smoke"` against a fresh
year, asserting the output lands under `smoke/` and nothing leaks into `archive/`. This
was a bug-fix/consistency fix (the pattern was already established three other places in
the codebase), not a design decision, so it wasn't asked about separately.

## Phase 3 — done

- [x] `lib/quotes.py` — `anchor_quote(quote_text, page_hint, document_text)`: whitespace-
      normalizes both sides, tries an exact substring match first, falls back to a
      `SequenceMatcher`-based fuzzy window search, applies the ~95% similarity threshold
      (§9). Returns `{anchored, similarity, offset, page_match}` matching
      `validation.schema.json`'s `anchor_result` exactly — `offset` is a `[start, end]`
      char-range pair into the whitespace-normalized text, `null` when unanchored;
      `page_match` is `null` when `page_hint` is `null` (HTML/DOCX quotes have no page to
      check).
- [x] `jobs/03-normalize/run.py` — walks the archive for doc dirs with a `manifest.json`
      lacking `extracted/text.txt`, dispatches on `manifest.json`'s `content_type` to
      `lib/text.py`'s `pdf_to_text`/`html_to_text`/`docx_to_text`, writes `text.txt`
      unconditionally (empty is valid — no text layer). Resumable: skips docs that already
      have `extracted/text.txt`; a single document's extraction failure is caught, logged,
      and does not abort the run.
- [x] `jobs/03-normalize/RUNBOOK.md`
- [x] Smoke check: `tests/test_phase3_normalize.py` — crawls `fixtures/crawl_pages/` via
      `jobs/02-archive/run.py` (real archive, local HTTP server, same pattern as
      `tests/test_phase2_archive.py`), normalizes it, and checks: PDF page markers correct;
      known-quote anchoring (verbatim, whitespace-reflowed, wrong page hint, unrelated
      quote, null page hint); the Westfield scanned-PDF fixture yields empty `text.txt`;
      empty text never anchors; a second normalize run is idempotent (writes nothing new).

### Bug found and fixed during Phase 3 verification

The drafted `lib/quotes.py` and `jobs/03-normalize/run.py` were both correct as written —
`anchor_quote` and the content-type dispatch matched §7/§9 and the schema on first run
against the fixtures. The one real bug was in the drafted **test**: `tests/
test_phase3_normalize.py` collected Eastview's document texts into a Python `set` and
picked "the PDF" via `next(t for t in ev_texts if "[[page 1]]" in t)`. Both Eastview's real
CHTR PDF and its non-CHTR decoy PDF (`decoy-menu.pdf`, a dining-services fixture) are
single-page, so both get a `[[page 1]]` marker — the `next()` over an unordered set
non-deterministically could return either one, and it was returning the decoy. Fixed by
selecting on the expected incident text (`"Zeta Psi Fraternity"`) instead of the page
marker, then asserting the marker is present on that selected text. No production code
changed as a result of this bug.

No new design decisions were needed from the user this phase — the drafted files matched
the plan's anchoring/dispatch spec exactly; the only ambiguity (the eastview text
selection) was a test-authoring bug, not a plan gap.

## Phase 4 — done

- [x] `jobs/04-extract/make_packets.py` — walks the archive for doc dirs with
      `extracted/text.txt` but no existing `ai/extract_v*/incidents.json`, writes one
      packet per document under `tasks/extract/{unitid}_{hash16}/` containing
      `prompt.md`, `original.pdf`/`original.html`, `text.txt`, `schema.json`, and a
      `metadata.json` stub. Resumable: a document with any existing extraction is
      skipped (re-extraction under a new prompt is a deliberate future action, not
      something this scan triggers).
- [x] `jobs/04-extract/prompt.md` — extraction instructions per §8: verbatim
      page-anchored quotes, everything nullable except `description_quote`, missing
      `organization_quote` is meaningful (not a placeholder to avoid), `is_chtr`
      classification is part of this pass, and the excluded-fields list (hazing-type
      taxonomy, sanction severity, `location`, `is_aggravated`, `date_reported`,
      `org_type`) called out explicitly as never to be added.
- [x] `jobs/04-extract/crosscheck_prompt.md` — the §9 second-pass prompt: verify a
      prior extraction against the original, field by field, citing pages, producing
      `{agrees, notes}` per incident index. Its header states plainly that this phase
      does not wire it into `validate.py` (no packet-creation script or archived
      crosscheck-output convention exists yet) — it is a deliverable prompt, not yet a
      running second pass.
- [x] `jobs/04-extract/validate.py` — (a) strict JSON-schema validation of
      `incidents.json` against `schema.json` (unknown fields rejected); invalid output
      is archived too, marked invalid, never discarded; (b) anchors every quote and
      `document.zero_incidents_quote` against `extracted/text.txt` via
      `lib/quotes.anchor_quote`; (c) assigns tier per §9's table — per incident, plus a
      document-level tier for the zero-incident-report case (see schema decision
      below); (d) archives `incidents.json` + a schema-compliant `metadata.json` +
      `validation.json` to `{doc_dir}/ai/extract_v{N}/`, where `doc_dir`/`N` come from
      the packet's `metadata.json` stub (never re-derived from the packet dirname).
      Idempotent/resumable: skips a packet whose target `extract_v{N}/incidents.json`
      already exists.
- [x] `jobs/04-extract/RUNBOOK.md`.
- [x] Smoke check: `tests/test_phase4_extract.py` — crawls + normalizes
      `fixtures/crawl_pages/` via 02/03 (same pattern as Phase 3's test; reused rather
      than building new Phase-4-specific fixtures, since it already covers an HTML
      CHTR, a real CHTR PDF + non-CHTR decoy PDF, and a scanned/no-text-layer PDF —
      exactly §14's three synthetic-institution shapes), then hand-adds one more
      document straight to the archive (a genuine anchorable zero-incident report) for
      the "fast" tier case, since no existing fixture covers it and adding one to
      `crawl_pages` would have changed the exact document counts Phase 2/3's tests
      assert on. Runs `make_packets.py`, hand-writes `incidents.json` into each packet
      (standing in for the agent) covering both tiers reachable this phase, runs
      `validate.py`, and asserts: north-ridge's two incidents anchor cleanly but land
      `flagged` (not `standard` — no crosscheck wired up); eastview's real CHTR PDF is
      `flagged` for a suspension sanction while its decoy PDF and index page are
      correctly non-CHTR; westfield's scanned PDF is `flagged` at the document level
      (`empty_text_layer`, zero-incident quote can't anchor against empty text); the
      hand-added document reaches `fast`. Both scripts are idempotent on a second run.

### Decisions made during Phase 4 (asked the user, since the plan was silent/ambiguous here)

- **Packet-to-archive link**: the plan's packet dirname
  (`tasks/extract/{unitid}_{hash16}/`) doesn't carry the institution slug, scrape_year,
  or which `extract_v{N}` a packet targets — nothing to reconstruct the archive
  write-back path from the dirname alone. Confirmed with the user: `make_packets.py`
  snapshots `doc_dir` (the full archive path) and `target_version` into the packet's
  `metadata.json` stub at packet-creation time; the agent copies that stub into its
  final metadata, adding only `model`/`created`; `validate.py` reads `doc_dir`/`target_version`
  straight from the stub and strips them back out before writing the final,
  schema-compliant `metadata.json` (which still has exactly the 4 fields
  `schemas/extract_metadata.schema.json` requires — that schema itself is unchanged).
- **Cross-check wiring**: Phase 4's task list included `crosscheck_prompt.md` but not a
  crosscheck packet-maker or an archived crosscheck-output convention. Confirmed with
  the user: `validate.py` always writes `crosscheck: null` this phase. Per §9's table
  this means no incident can reach the `standard` tier yet (its condition requires
  cross-check agreement) — only `fast` (zero-incident reports) and `flagged` are
  reachable from this job until a later phase adds the second-pass packet flow.
- **Zero-incident report tier has no home in `validation.schema.json` as shipped in
  Phase 0** (flagged as open in Phase 1's notes): the `fast` tier applies to a whole
  zero-incident report (`incidents: []`), not to any entry in the per-incident
  `incidents[]` array, and the schema had no document-level tier field. Confirmed with
  the user: extended `validation.schema.json`'s `document` object with `tier`
  (`"fast" | "flagged" | null`) and `flagged_reasons` (mirroring the per-incident
  shape), rather than overloading `incidents[]` with a synthetic whole-document entry.
  Updated `fixtures/schema_examples/validation.example.json` and the one mini_archive
  fixture with a `validation.json` (`100001_alpha-college`) to match — both were
  non-zero-incident cases, so both just get `tier: null, flagged_reasons: []`.
- **Sanction-wording match for the "suspension/expulsion" flagged condition**: §9 says
  "sanction quote containing suspension/expulsion" verbatim, but real sanction text
  uses inflections ("suspended", "expelled") rather than those exact nouns — e.g. this
  phase's own eastview fixture ("Sanction: suspension through Spring 2027.") and the
  pre-existing `100004_delta-tech` fixture ("Organization expelled from campus.") use
  different stems. Matched by stem (`suspen|expel|expuls`, case-insensitive) rather
  than the literal nouns, so real-world phrasing isn't missed; not asked separately
  since it's a direct, low-judgment reading of the same rule, not a gap in the plan.

## Phase 5 — done

- [x] `jobs/06-publish/catalog_schema.sql` — the six tables from §12, columns exactly
      as named there (no invented fields — for `institutions`, whose §12 entry ends in
      an ellipsis, this means literally just `unitid, name, state`, populated from
      three of `schools.csv`'s six columns). Fully constrained per the user's choice:
      `NOT NULL` wherever the source artifact schema requires the field, foreign keys
      wherever §12 implies a relationship, and indexes on every FK column. `incident_id`
      / `report_id` are `short_hash(sha256(...))` (16 hex chars), matching the archive's
      own doc-hash precedent rather than inventing a new ID length.
- [x] `jobs/06-publish/rebuild.py` — `DROP SCHEMA public CASCADE` → recreate → walk the
      *entire* archive → repopulate every table, per invariant 2. `institutions` from
      `sources/schools.csv`, `documents` from every `manifest.json`, `reporting_status`
      from every `status.json`. `reports`/`incidents`/`incident_sanctions` only from
      incidents with an `approved`/`corrected` `review.json`, matched to
      `ai/extract_v{N}/incidents.json` via `extraction_ref.file_hash` (sha256 of that
      file) + `incident_index` — the same hash-matching invariant `status.py` already
      uses. `incident_id`/`report_id` are computed from the *original, uncorrected*
      extraction so a reviewer fixing a typo never changes an incident's public ID.
      A `corrections` dict overrides the field(s) it names before the row is written;
      a present `second_review`'s `decision`/`corrections` apply after the first
      review's and win on any field both name. A single incident's correction failing
      to apply is logged and that incident skipped, not an abort of the whole rebuild
      (Phase 2/3 precedent); the whole populate step runs in one transaction, so any
      earlier failure (e.g. a DB error) rolls back cleanly with nothing half-written.
- [x] `jobs/06-publish/RUNBOOK.md`.
- [x] Smoke check: `tests/test_phase5_publish.py` — builds a real archive the same way
      `test_phase4_extract.py` does (crawl + normalize `fixtures/crawl_pages/`,
      `make_packets.py` + hand-authored `incidents.json` standing in for the agent,
      then `validate.py`), then hand-writes `review.json` files covering every path:
      an `approved` incident with no corrections, a `rejected` incident (must never
      enter the catalog), an incident with no review at all (must never enter the
      catalog), and an incident `corrected` twice — first review and second_review
      both correcting the same field to different values, proving second_review wins.
      Runs `rebuild.py` twice against a scratch local Postgres database (this machine
      already runs a local `postgres` server on 5432 with trust auth — the test
      creates/drops a throwaway database around itself, no Neon credentials needed)
      and asserts the row counts, which incidents landed (and which didn't), the
      winning correction, and that every row and ID is byte-identical between the two
      runs (invariant 9).

### Decisions made during Phase 5 (asked the user, since the plan was silent/ambiguous here)

- **Which fixture archive the smoke check rebuilds against**: reusing Phase 1's
  `fixtures/mini_archive/` was considered, but its `validation.json` files predate
  Phase 4's schema extension (no `document.tier`/`flagged_reasons`) and wouldn't
  validate against the current schema. Confirmed with the user: build a fresh archive
  via the real pipeline (02/03/04 against `fixtures/crawl_pages/`), matching
  `test_phase4_extract.py`'s approach, then hand-write `review.json` files onto the
  result — this is what `test_phase5_publish.py` does. `fixtures/mini_archive/` is
  untouched.
- **`corrections` field-path vocabulary and first-vs-second-review conflicts**:
  confirmed with the user a flat dot-path vocabulary scoped to catalog columns
  (`rebuild.py`'s `CORRECTION_FIELDS`: `organization_quote.text/.page`,
  `description_quote.text/.page`, `findings_quote.text/.page`, `alcohol_involved`,
  `drugs_involved`, `dates.incident_quote.text`, `dates.incident_start/.end`,
  `dates.investigation_initiated`, `dates.resolved`) — `sanction_quotes` (a list) and
  any document-level field are deliberately not correctable this way, since
  `review.json`'s `extraction_ref` scopes a review to one incident, never a document.
  A present `second_review`'s corrections are applied after the first review's and
  win on any field both name; the same last-write-wins rule extends to
  `decision`/`rejection_reason` (not explicitly asked, but a direct extension of the
  rule the user did confirm, not a separate judgment call).
- **Column types/constraints**: §12 names columns, not types. Confirmed with the user:
  fully constrained (`NOT NULL` per the source schema's own required fields, FKs
  between every table §12 implies a relationship for, indexes on FK columns).
- **Zero-incident ("fast" tier) reports and `review.json`**: `extraction_ref.incident_index`
  is a required non-null integer, but a zero-incident report has no `incidents[]` to
  index — there's no way yet to represent "a reviewer approved this zero-incident
  report" in `review.json` as shipped. Confirmed with the user: out of scope for this
  phase. `rebuild.py` only ever populates `reports`/`incidents`/`incident_sanctions`
  for documents with ≥1 incident that has an approved/corrected review; a
  zero-incident document still gets a `documents` row (from its `manifest.json`) but
  never a `reports` row, and `reports.is_zero_incident` — present per §12's schema —
  is never written `true` yet. Revisit once Phase 7a/7b's review app defines what it
  actually writes for this case.

## Phase 6 — done

- [x] `sources/schools.csv` — **created for real for the first time.** The user
      supplied the source list (`~/Downloads/listofschools.csv`: `row_order, unitid,
      institution, chtr_url, status, evidence`, 1,484 rows, no duplicate unitids, every
      status/chtr_url/evidence blank). Mapped to schools.csv's columns 1:1
      (`institution` → `name`); see the `state` decision below for why `state` is a
      blank column rather than populated. `sources/` did not exist as a directory
      before this phase (Phase 0's scaffold didn't create it, since Phase 6 is what
      first populates it) — created it here.
- [x] `jobs/01-discover/prompt.md` — search instructions per §7: one candidate per
      school actually found (never a placeholder for "not found" — that school is
      just omitted and retried next pass), verbatim evidence quotes, confidence as
      the agent's own calibrated estimate (informational only — see decision below),
      never edits `schools.csv`, never fetches/archives documents (that's 02-archive's
      job after confirmation).
- [x] `jobs/01-discover/make_batches.py` — slices every school with a blank
      `url_status` in `sources/schools.csv` into `tasks/discover/batch_{NNN}/`
      directories (~25–50 schools each, default 40, `--batch-size` to override), each
      containing `prompt.md` + `schema.json` + `schools_slice.csv`. Resumability is
      driven entirely by `schools.csv`'s own `url_status` column (no scanning of
      `tasks/` needed): batching marks batched rows `url_status=pending` so a second
      run never re-batches them; `confirmed`/`no_url` rows (from a prior merge) are
      likewise never re-batched; a *rejected* candidate reverts to blank `url_status`
      (see `merge.py` below) so it becomes eligible again on the next annual pass.
      Batch numbering continues from the highest existing `batch_NNN` dir, so a
      crash/interrupted session never collides with or reuses a prior batch number.
- [x] `jobs/01-discover/decisions.schema.json` — new schema (not named in the plan's
      §4 schema inventory, but a direct extension of the same "any file a script reads
      to make a decision should be schema-validated" pattern the plan uses everywhere
      else): `{schema_version, batch, decisions: [{unitid, decision: "confirmed"|
      "rejected", proposed_url}]}`. Lives in the job dir (like `candidates.schema.json`)
      since it's specific to this job's packets, not a cross-job artifact.
- [x] `jobs/01-discover/merge.py` — for every `tasks/discover/batch_{NNN}/` with a
      `candidates.json` **and** a `decisions.json` that covers every candidate in the
      batch (a partial `decisions.json` — operator still working through it — is left
      untouched, not an error), validates: unitid exists in `schools.csv`, the
      decision's `proposed_url` matches the corresponding candidate's exactly (an
      operator confirms *this* candidate, not an arbitrary URL), URL is well-formed
      (http/https + non-empty netloc). Merges confirmed → `chtr_url`/
      `url_status=confirmed`/`evidence`; rejected → those three fields cleared back to
      blank (re-eligible for batching). Asserts `schools.csv`'s row count and unitid
      set are unchanged before writing it back — no row deletion, ever. Marks each
      merged batch with a `merged.json` sentinel so a later batch that recycles the
      same unitid (a rejected school gets re-batched under a new batch number) never
      causes this batch's now-stale `decisions.json` to be reapplied.
- [x] `jobs/01-discover/RUNBOOK.md`.
- [x] Smoke check: `tests/test_phase6_discover.py` — a synthetic 5-school
      `schools.csv` copy (not the real one): batches into 2 batches of size 3/2;
      hand-writes `candidates.json` + `decisions.json` for batch_001 (2 confirmed, 1
      rejected) and a `candidates.json` with an *incomplete* `decisions.json` for
      batch_002; runs `merge.py` and asserts batch_001 merges (confirmed rows get
      `chtr_url`/`evidence`, rejected row reverts to blank, row count/unitid set
      unchanged, `merged.json` written) while batch_002 is skipped untouched; a second
      `merge.py` run is a full no-op (idempotent); a second `make_batches.py` run
      re-batches the rejected school into a new `batch_003` while confirmed/still-
      pending schools are never re-batched. All prior phases' smoke checks re-run
      clean afterward (`sources/schools.csv` now existing for real doesn't perturb
      them — they all build their own throwaway CSVs, same as before).

### Decisions made during Phase 6 (asked the user, since the plan was silent/ambiguous here)

- **Where the real ~1,484-institution list comes from**: confirmed with the user —
  they supplied `~/Downloads/listofschools.csv` directly this session rather than
  deferring population to a follow-up task.
- **Missing `state` column**: the user's source list has no `state` column (just
  `row_order, unitid, institution, chtr_url, status, evidence`), unlike the six-column
  shape (`unitid, name, state, chtr_url, url_status, evidence`) every prior phase
  assumed for `schools.csv`. Confirmed with the user: keep the six-column shape with
  `state` always blank for now, rather than dropping the column (which would have
  required touching Phase 5's `catalog_schema.sql`/`rebuild.py`). `state` can be
  backfilled later from an IPEDS unitid lookup without any schema change. **Anyone
  relying on `institutions.state` in the catalog (Phase 5) should know it is empty
  for every row until that backfill happens.**
- **Decisions file shape/filename**: confirmed with the user —
  `tasks/discover/{batch}/decisions.json`, mirroring `candidates.json`'s shape
  (`{schema_version, batch, decisions: [{unitid, decision, proposed_url}]}`), with a
  new `decisions.schema.json` in the job dir to validate it (see above).
- **Confidence field semantics**: confirmed with the user — `confidence` is shown to
  the operator alongside each candidate as one input to their own judgment, but
  `merge.py` never gates or auto-decides anything on it (invariant 6: only an operator
  decision, written to a file, moves a candidate to `confirmed`/`rejected`).
- **Rejected candidates and re-eligibility** (not asked separately, but a judgment call
  worth recording): a rejected decision resets `url_status` to blank rather than a
  fourth status value like `"rejected"`, so the school is picked up again by the next
  `make_batches.py` pass without any change to `status.py`'s existing 3-value
  `discover_stats` enum (`confirmed`/`pending`/`no_url`) from Phase 1.

## Phase 7a — done

- [x] `jobs/05-review/ingest.py` — `ingest_review(doc_dir, review_json) -> key`, the
      validating write path for a human review decision, per §10/§11/§16. In order,
      never partially writing: (a) validates `review_json` against
      `schemas/review.schema.json`; (b) confirms `extraction_ref.file_hash` matches
      the sha256 of some `{doc_dir}/ai/extract_v{N}/incidents.json` — searches every
      version under `doc_dir`, not just the current one, so a review submitted
      against an older extraction still pins correctly (invariant 9); (c) confirms
      `extraction_ref.incident_index` is in range; (d) if the *resolved* decision
      (second_review's decision overrides the first's, same last-write-wins rule
      `jobs/06-publish/rebuild.py` already applies at read time — factored out here
      as `_resolved_decision`, mirrored not imported, since it's a few lines) is
      `"corrected"`: re-anchors every quote-bearing field a correction touches
      (`organization_quote`, `description_quote`, `findings_quote`,
      `dates.incident_quote`) via `lib.quotes.anchor_quote` against
      `extracted/text.txt` — a corrected quote that no longer anchors rejects the
      whole review, nothing written; (e) writes to
      `{doc_dir}/reviews/{incident_index}_{reviewer-slug}_{ts}.review.json`. Raises
      `IngestError` (never a partial write) on any failure. Also runnable as a CLI
      (`python jobs/05-review/ingest.py --doc-dir … --review …`) for manual use.
- [x] `jobs/05-review/RUNBOOK.md`.
- [x] Smoke check: `tests/test_phase7a_review.py` — builds a real archive the same
      way test_phase4/5 do (crawl + normalize `fixtures/crawl_pages/`, `make_packets`
      + hand-authored `incidents.json` standing in for the agent, then `validate.py`
      against north-ridge's HTML + eastview's real CHTR PDF), then calls
      `ingest_review()` directly and asserts: a valid `approved` review lands at the
      exact expected key with byte-identical content and the confirmed
      slug/timestamp filename derivation; a `file_hash` matching no extraction under
      `doc_dir` is rejected with nothing written; an out-of-range `incident_index` is
      rejected; schema-invalid input (bad `decision` enum, an unknown field) is
      rejected; a `corrected` review with a still-anchorable corrected quote
      succeeds; one with an unanchorable corrected quote is rejected, nothing
      written; a `second_review` overriding `corrected` → `approved` skips
      re-anchoring the first review's (bad) correction entirely; and when both first
      and second `_review` correct the *same* quote field to different values, the
      second's — not the first's — is the one actually re-anchored (proving
      last-write-wins is applied before anchoring runs, not just at rebuild time).
      All 7 prior phases' smoke checks re-run clean afterward.

### Decisions made during Phase 7a (asked the user, since the plan was silent/ambiguous here)

- **Worker scope**: the plan's Phase 7a deliverable is literally "Review Worker +
  ingest.py", but a Cloudflare Worker runs JS/TS and cannot call Python directly, and
  no live Cloudflare/R2 credentials exist in `.env` yet. Confirmed with the user:
  build `ingest.py` as pure, locally-testable Python this phase (tested against
  `ARCHIVE_LOCAL_ROOT`, same pattern as every prior phase) and defer writing the
  actual Cloudflare Worker (TypeScript, wrangler config, R2 binding, Access
  middleware) to a separate follow-up phase once real credentials exist. That future
  Worker is expected to port `ingest_review()`'s logic to TypeScript (or call out to
  it) — `ingest.py` has no side effects beyond `lib/r2.py` and raises cleanly on
  every rejection path specifically so that port is mechanical.
- **`doc_dir` is not part of review.json**: `review.schema.json` (fixed in Phase 0,
  `additionalProperties: false`) only carries `extraction_ref.file_hash` +
  `incident_index`, not which document that extraction belongs to. Not explicitly
  asked (a direct consequence of not touching the existing schema), but recorded as
  a real design decision: `ingest_review(doc_dir, review_json)` takes `doc_dir` as a
  separate argument, supplied by the caller — in the real app this is
  `documents.storage_key` from the catalog's queue view (§12), which the review UI
  already has open. The eventual Worker's request shape (e.g. a route parameter)
  needs to carry it alongside the review.json body.
- **Reviewer identity**: §11 says `reviewer` comes from the Access JWT, but Access
  isn't wired up yet. The user asked what Access/JWT even means rather than
  committing to a stand-in; given that, went with the recommended default:
  `ingest_review()` trusts whatever `reviewer` string it's handed (validated only for
  shape, via the schema's `{"type": "string"}`) and does no identity verification of
  its own — that check is explicitly the future Worker's job once Access exists, not
  `ingest.py`'s. The smoke check hand-supplies plain reviewer strings, standing in
  for "the Worker already verified this against the Access JWT before calling
  ingest.py."
- **`{reviewer-slug}` / `{ts}` filename derivation**: the user also deferred on this
  one. Went with the recommended default: `reviewer-slug` = `reviewer` lowercased,
  every run of non-alphanumeric characters collapsed to a single `-`, leading/
  trailing `-` stripped (e.g. `"Jane Doe <jane@x.edu>"` → `"jane-doe-jane-x-edu"`);
  `ts` = `reviewed_at` (already required, ISO 8601) reformatted to a compact
  filename-safe UTC form with punctuation stripped (e.g. `2026-02-10T18:05:30Z` →
  `20260210T180530Z`). Both covered by the smoke check's first case.
- **R2 for the smoke check**: the user mentioned having real R2 read/write API keys,
  but no `.env` exists in the repo yet. Confirmed with the user: keep this phase's
  smoke check local-only (`ARCHIVE_LOCAL_ROOT`), matching every prior phase — nothing
  in `ingest.py` is R2-specific (it only calls `lib/r2.py`), so pointing it at real R2
  later is purely an env var change, not a code change. Setting up `.env` with real
  keys is left for whenever the actual Worker deploy (the deferred follow-up above)
  needs them.

## Phase 7b — done

- [x] `jobs/05-review/app/worker/` — the real Cloudflare Worker (TypeScript), built
      and tested this phase rather than deferred further. `src/quotes.ts` and
      `src/hashing.ts` port `lib/quotes.py`/`lib/hashing.py` (verified byte-for-byte
      identical to the Python side, including exact similarity scores and offsets, on
      the same fixture cases). `src/ingest.ts` is a line-for-line port of
      `ingest.py`'s `ingest_review()`. `src/queue.ts` builds the reviewable queue by
      walking the archive directly (mirrors `status.py`'s `walk_archive`) rather than
      reading Postgres — the catalog only ever holds already-reviewed rows, so there
      is no "pending" projection to read a queue from there; this also means the app
      needs no Neon credentials at all, only R2. `src/access.ts` resolves reviewer
      identity from `Cf-Access-Jwt-Assertion` (decoded, not signature-verified — real
      Access is expected to have already verified it at the edge) with a
      `DEV_MODE`-gated local fallback. `src/index.ts` wires the API routes (`/api/
      queue`, `/api/document`, `/api/original` — sanitizing HTML via `HTMLRewriter`
      since archived HTML is from an untrusted third party — `/api/review`) plus two
      `DEV_MODE`-only routes (`/api/dev-seed`, `/api/dev-dump`) that let the smoke
      check load/inspect a real fixture archive in Miniflare's local R2 simulation,
      since there's no other way to pre-populate it from files on disk. `wrangler.toml`
      configures the R2 binding and `DEV_MODE=true` for local dev; nothing is deployed.
- [x] `jobs/05-review/app/pages/` — the static review UI (plain HTML/CSS/JS, no build
      step, per §11's "Pages (static UI)"). One incident (or, for a "fast"-tier
      zero-incident report, the whole document) per screen: PDF.js canvas for PDFs,
      or a sanitized HTML document injected via `srcdoc` into a `sandbox=
      "allow-same-origin"` iframe with no `allow-scripts` (so nothing archived from a
      third-party site can execute) for HTML. Anchored quotes are pre-highlighted —
      a best-effort text search purely for the reviewer's convenience; `validation.json`
      remains the sole authority on whether a quote is trustworthy. Extracted text is
      shown collapsed and labeled navigation-only. Keyboard-driven: `A` approve, `F`
      fix (correction form covering every field `06-publish/rebuild.py`'s
      `CORRECTION_FIELDS` can apply), `X` reject (reason picker), `E` escalate,
      `←`/`→` PDF page, `Esc`/`?` for the shortcut panel. Scanned-PDF flagged view:
      PDF.js renders the page's visual content regardless of text layer, so "page
      image beside the quotes" (§11) falls out of the same canvas with no separate
      page-image pipeline — no highlight overlay is drawn since nothing anchors.
- [x] Two additive `schemas/review.schema.json` changes (both confirmed with the
      user — see decisions below): `extraction_ref.incident_index` may be `null`
      ("the whole document" — the only way to review a "fast"-tier zero-incident
      report, which has no `incidents[]` to index), and `decision` gains
      `"escalated"` (a single reviewer couldn't decide; resolved later via the
      *existing* `second_review` mechanism flagged-tier dual review already uses).
      `jobs/05-review/ingest.py` and `worker/src/ingest.ts` both updated in lockstep
      (a document-level review can never resolve to `"corrected"` — rejected, no
      correction vocabulary exists for the document object). `jobs/06-publish/
      rebuild.py` writes a `reports` row (`is_zero_incident=true`, no `incidents`
      rows) for an approved document-level review, closing the gap Phase 5's notes
      flagged as deferred to "whatever Phase 7a/7b's review app defines." `status.py`
      gained `review.escalated_pending` (an unresolved escalation isn't counted as
      `decided`) so the operator's menu surfaces it.
- [x] `jobs/05-review/RUNBOOK.md` rewritten to cover the app (dev commands, routes,
      the Phase 7b schema additions) alongside the still-accurate `ingest.py` section.
- [x] Smoke checks: `tests/test_phase7b_review_app.py` builds a real fixture archive
      (crawl + normalize `fixtures/crawl_pages/`, `make_packets`/hand-authored
      `incidents.json`/`validate.py`, plus the hillcrest zero-incident fixture reused
      from Phase 4/5), launches a real `wrangler dev` subprocess (Miniflare's local R2
      simulation — no live credentials), seeds it via `/api/dev-seed`, and drives the
      HTTP API directly: queue ordering, document/original fetch, approve/escalate/
      second-review-resolve/document-level-approve, and rejection of schema-invalid
      or hash-mismatched reviews (422) — including a regression check that the Worker
      stamps its own resolved identity onto `second_review.reviewer`, not just the
      top-level `reviewer` (a real bug caught during manual testing, see below).
      `jobs/05-review/app/worker/test/*.test.ts` (26 cases, `npm test`) unit-tests
      `quotes.ts`/`ingest.ts`/`queue.ts` in isolation via an in-memory `ArchiveStore`.
      Both were also driven for real: `wrangler dev` + a static file server for
      `pages/`, exercised in an actual browser against seeded fixture data (approve,
      fix/correct, reject, escalate, and second-review resolution all clicked
      through, not just called via HTTP).
- [x] All prior phases' Python smoke checks re-run clean afterward.

### Bugs found and fixed during Phase 7b's browser verification

Driving the actual UI in a browser (not just the automated HTTP-level smoke check)
caught three real bugs the automated tests didn't, because none of them are visible
from an HTTP response alone:

- **CSS `[hidden]` override**: several elements (`.badge`, `#help-overlay`,
  `#correction-form`) set an explicit `display` value in `styles.css`, which beats the
  browser's default `[hidden] { display: none }` regardless of selector specificity
  (author styles always outrank UA styles in the cascade) — toggling `.hidden` from
  `app.js` had no visual effect. Fixed with a single `[hidden] { display: none
  !important; }` rule.
- **`second_review.reviewer` wasn't stamped**: `index.ts`'s `handleReviewSubmit`
  overwrote the top-level `reviewer` field with the resolved Access/DEV_MODE identity,
  but not `second_review.reviewer` — a second reviewer resolving an escalation could
  have their submission attributed to whatever the client claimed. Fixed, and now
  covered by `tests/test_phase7b_review_app.py`'s step 5.
- **PDF highlight-box misplacement**: `drawPdfHighlight` computed box width as
  `Math.hypot(tx[0], tx[1]) * item.width`, double-counting the font-size scaling
  already baked into the combined viewport+item transform (`item.width` is already in
  unscaled PDF user-space units) — boxes rendered thousands of pixels wide. Fixing the
  width alone wasn't sufficient: `#pdf-canvas` also had `max-width: 100%; height:
  auto`, letting the browser rescale the rendered canvas independently of
  `#pdf-highlight-layer` (sized in the canvas's *intrinsic* pixel space), so the two
  drifted apart. Fixed by having `renderPdfPage()` choose the PDF.js render scale
  from the container's actual width up front (so the canvas's intrinsic size already
  fits, no CSS-level rescaling needed) and removing the CSS rule entirely — verified
  pixel-aligned in the browser afterward.

### Decisions made during Phase 7b (asked the user, since the plan was silent/ambiguous here)

- **Build the real Worker this phase, but stay local/test-only**: confirmed with the
  user — port `ingest.py` to TypeScript now (tested via `wrangler dev` against
  Miniflare's local R2 simulation) rather than deferring further, but do not deploy
  live or set up real R2/Access credentials this session. `.env` / a live deploy is
  left for a dedicated follow-up when the user is ready to hand over credentials.
- **The zero-incident "fast" tier gap** (flagged as open since Phase 5): confirmed
  with the user to close it by extending `review.schema.json` (nullable
  `incident_index`) rather than leaving fast-lane review unbuilt — see above.
- **The "escalate" mechanism**: confirmed with the user to add `"escalated"` as a
  real `decision` value (an artifact, per invariant 6 — not a silent no-op skip) that
  gets resolved through the *existing* `second_review` field rather than inventing a
  new one, since that's exactly the mechanism flagged-tier dual review already needed.
- **Queue source is the archive, not Postgres**: not explicitly asked, but a direct
  consequence of the catalog schema's own design (Phase 5: only approved/corrected
  rows ever enter `reports`/`incidents`) — §11's "reads from the catalog's queue view"
  can't literally mean Postgres, since pending items never appear there. Recorded as a
  real design decision since it determines the app needs zero Neon credentials.
- **HTML sanitization approach**: not asked separately — using the Workers runtime's
  built-in `HTMLRewriter` (streaming, strips `<script>`/`<iframe>`/`<object>`/
  `<embed>`/`<form>`, `on*` attributes, `javascript:` URLs, meta-refresh) rather than a
  hand-rolled regex parser, with the Pages UI's scriptless sandboxed iframe as a
  second, independent layer of defense.

## Phase 8 (removed)

`migration/` (`backfill_manifests.py` + `export_legacy.py`, per what was
IMPLEMENTATION_PLAN.md §13) was built and smoke-tested against a synthetic old-system
fixture, then **removed entirely** once Mahir confirmed there is no old system to migrate
from — no separate old R2 bucket/Neon database exists. Removed: `migration/` (all
files), `tests/test_phase8_migration.py`, the `OLD_R2_*`/`OLD_DATABASE_URL` entries from
`.env`/`.env.example`, and IMPLEMENTATION_PLAN.md §13 + its repo-layout entry + its Phase
8 table row. §9's calibration paragraph was reworded to no longer depend on a legacy
answer-key (volunteers now calibrate against a shared initial batch of real incidents
instead). See git history for the removed code if a legacy source ever does turn up.

## Phase 9 — done

Mahir supplied a "CHTR Data Dictionary" Airtable base (tabs: Data Dictionary, Pipeline
Logic, Controlled Vocabularies — 124 fields / 21 pipeline-logic rules / 53 controlled-vocab
terms across 15 tables) defining a substantially richer Postgres design than v2.0's
six-table catalog, and directed a full migration. Pulled via the Airtable API and
mechanically rendered into **[`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md)**, which is now
the authoritative field-by-field reference for the catalog. `IMPLEMENTATION_PLAN.md`
(now v3.0) and `OPERATIONS.md` were rewritten to match — see `IMPLEMENTATION_PLAN.md`'s
own v3.0 preamble for the full list of superseded sections (§2 invariant 5, §3, §6, §7,
§8, §9, §10, §11, §12, §14, §16). No code changed this phase; Phases 10–17 (already
added to the table above) carry out the actual implementation, one at a time, same
discipline as Phases 0–8.

### Decisions made during Phase 9 (asked the user, since this was a genuine
architecture re-litigation, not silence/ambiguity in an already-settled plan)

- **R2 stays the sole source of truth.** Postgres — both a new `staging` schema and
  `public` — remains a disposable projection, fully dropped and rebuilt from the archive
  on every publish (invariants 1/2 unchanged, just reshaped to 15 tables). Confirmed
  explicitly over the alternative (Postgres becoming stateful/authoritative), which
  would have broken invariant 2 outright.
- **Quote-anchoring and the fast/flagged/standard tier system are dropped entirely.**
  `lib/quotes.py`, `schemas/validation.schema.json`'s anchoring shape, and
  `validate.py`'s tier assignment are retired in favor of the new schema's
  `extraction_confidence` (per-incident, AI self-reported) + `Staging_incident_review_flags`
  (typed, resolvable) mechanism. This also retires the dual-review/`escalated`/
  `second_review` machinery — confirmed as a direct consequence, since the new schema's
  `human_review_status` enum is only `Pending review / Approved / Rejected` with no
  second-reviewer field anywhere in the 124-field dictionary. Review is now
  single-reviewer, flag-informed, not tier-routed.
- **The review app keeps its current architectural pattern.** It still reads the archive
  directly (never Postgres — the DB only ever holds already-reviewed rows) and writes
  validated decision files to R2 through a validating ingest path; Postgres's `staging`
  schema is just a richer projection of those files, rebuilt the same way `public`
  already is. This was flagged as open ("decide as part of the plan") and resolved as
  the natural extension of the R2-authoritative decision above, not a new pattern.
- **`01-discover` (agent web-search → operator-confirm → `merge.py`) is kept exactly as
  built.** It's still what determines the confirmed `chtr_url`. Mahir was explicit that
  the *agent* should keep doing its own discovery, with the existing Airtable
  schools-registry base (`AIRTABLE_TOKEN`/`AIRTABLE_BASE_ID`/`AIRTABLE_TABLE_NAME`) used
  only as a cross-check afterward — a mismatch is surfaced for operator attention, never
  silently overwriting either the agent's finding or Airtable's recorded value. This
  finishes the in-flight `import_airtable.py` work (see prior "Next session should" notes,
  now superseded) from a cross-check angle rather than the original backfill-only design;
  `import_airtable.py` still doesn't exist yet — Phase 12 writes it.
- **No `reports`/`incident_sanctions` tables in v3.0.** The new schema has no
  document-level concept at all (reporting period, publication date, is-zero-incident) —
  it's incident-centric, with `Artifacts` as the only document-level row. This wasn't a
  question to ask Mahir — it's a direct reading of the data dictionary's own 15-table
  list, which simply doesn't include those concepts. Recorded as a real design
  consequence: document-level extracted fields (`reporting_period_start/end`,
  `publication_date`, `zero_incidents_statement`) stay archive-only in `incidents.json`,
  with no catalog column, until/unless that turns out to matter for the public site.
- **The old "CHTR Data Dictionary" Airtable base connection was disconnected** once
  `DATABASE_SCHEMA.md` was generated from it — confirmed with Mahir that no ongoing sync
  is needed (it was a one-time schema-design pull, unlike the schools-registry base,
  which stays live per the discover-cross-check decision above). Removed
  `DATA_DICT_AIRTABLE_TOKEN`/`DATA_DICT_AIRTABLE_BASE_ID` from `.env`.

## Phase 10 — done

- [x] `schemas/validation.schema.json` — collapsed to `{schema_version: 2, valid,
      schema_errors}`, dropping the whole anchor_result/tier/crosscheck structure.
- [x] `jobs/04-extract/schema.json` — incidents.json v2: raw+normalized+precision date
      triples, independent `alcohol_involved`/`drugs_involved` enums, `determination_status`,
      an organization proposal (`organization_name_raw/normalized`, `organization_type`),
      per-incident `extraction_confidence` + `flags[]` (typed `flag_type`/`field_name`/
      `note`). No more `{text, page}` quote objects anywhere.
- [x] `schemas/review.schema.json` — review.json v2: `corrections` is now a list (one
      entry per changed field: `field_name`/`original_value`/`corrected_value`/
      `correction_type[]`), a new independent `organization_review` object, and `tier`/
      `escalated`/`second_review` all removed.
- [x] Three new top-level schemas: `schemas/ledger_entry.schema.json`,
      `schemas/data_check.schema.json` (includes an `airtable_cross_check` object per
      IMPLEMENTATION_PLAN.md §7's discover cross-check), `schemas/pipeline_run.schema.json`.
- [x] `schemas/extract_metadata.schema.json` unchanged — its shape (`model`,
      `prompt_version`, `created`) didn't need to change.
- [x] `fixtures/schema_examples/` updated: `incidents.example.json`,
      `incidents_zero.example.json`, `validation.example.json`, `review.example.json`
      reshaped to v2; three new example files for the new schemas.
- [x] Smoke check: `tests/test_phase0_schemas.py` extended with 3 new cases (now 12
      total) — all pass.

No new design decisions asked of the user this phase — every shape here is a direct,
mechanical reading of `DATABASE_SCHEMA.md`'s `Staging_incidents`/`Staging_organizations`/
`Staging_incident_corrections`/`Ledger`/`Data_checks`/`Pipeline-runs` field lists, per
Phase 9's already-confirmed decisions.

## Phase 11 — done

- [x] `lib/fingerprint.py` — new: `strip_boilerplate_tokens` (regexes for month-day-year,
      ISO, and slash dates, bare 4-digit years, and "this/current reporting period"
      phrases), `content_fingerprint` (sha256 of the stripped text — `Ledger.
      fingerprint_content_hash`), `url_hash16` (stable id for a URL, used as the
      `ledger/{url_hash16}.json` filename).
- [x] `jobs/02-archive/run.py` — `write_ledger_entry` (updates in place, preserving
      `first_seen_date` across re-crawls; PDFs fall back to the raw `content_hash` as
      their fingerprint since 02-archive has no PDF text layer available — that's
      03-normalize's job, and duplicating it here would cross the existing fetch/extract
      boundary), wired into `store_document` so a ledger entry is written for every URL
      actually archived (dedup or not), independent of the storage decision.
      `write_data_check` writes `data_check.json` unconditionally for every institution
      actually processed this cycle (no_url, not-yet-confirmed, or crawled) — mirrors
      `status.json`'s "absence is data" treatment (invariant 8). `start_pipeline_run`/
      `complete_pipeline_run` bookend each batch `run()` with a `pipeline_runs/{run_id}
      .json` record; not institution-scoped, so it lives at the archive root.
- [x] Smoke check: `tests/test_phase2_archive.py` extended — schema-validates the new
      `ledger/*.json`/`data_check.json` files (the test's own naive "everything that
      isn't status.json must be a manifest" dispatcher needed updating too), asserts
      `data_check.json`'s `pipeline_status`/`chtr_index_url` for both a confirmed and a
      `no_url` institution, and asserts a re-crawl in a new scrape year (run 3) updates
      the *same* ledger entry in place (`first_seen_date` unchanged, still exactly one
      file) rather than creating a second one.

### Decisions made during Phase 11 (not asked separately — direct, low-judgment readings
of Phase 9's already-confirmed decisions, same bar as every prior phase's "not asked
separately" notes)

- **`checked_by` and `prompt_version` placeholders:** `data_check.json`'s `checked_by`
  is hardcoded to `"01-discover-agent"` for now (there's no real human-checker identity
  flowing through the pipeline yet — that's exactly what Phase 12's Airtable cross-check
  starts to address, and `airtable_cross_check` is always `null` until then).
  `pipeline_run.json`'s `prompt_version` is `"n/a"` for 02-archive runs, since it isn't
  an AI job and has no prompt — the field's real meaning (which extraction prompt ran)
  applies starting Phase 14.
- **Ledger entries are only written for URLs actually archived**, not every URL the
  crawler merely visited without hazing signal — matches the existing crawl's own
  distinction (only signal-bearing pages/PDFs ever reach `store_document`) rather than
  inventing a broader "every fetch" ledger.
- **PDF fingerprinting has no boilerplate-stripping step**, unlike HTML — it falls back
  to the raw `manifest.json` `sha256`. Text-layer extraction is 03-normalize's job by
  existing design (Phase 1's decision log); adding it to 02-archive would duplicate that
  boundary just for this one new signal.

## Phase 12 — done

- [x] `jobs/01-discover/import_airtable.py` — finally written (in progress since before
      the v3.0 migration, original backfill-only design superseded by Phase 9's
      cross-check decision). `fetch_airtable_urls()` pulls `UNITID`/`Transparency Report`
      from the existing schools-registry Airtable base (paginated, ~1,500 rows, cheap
      enough to pull in full each run — no per-unitid lookup endpoint exists).
      `cross_check()` compares every `url_status=confirmed` institution's `chtr_url`
      against Airtable's value; writes `tasks/discover/airtable_cross_check.json`
      (schema: `jobs/01-discover/airtable_cross_check.schema.json`). Never touches
      `schools.csv` — confirmed by the smoke check's own before/after comparison.
- [x] `jobs/02-archive/run.py` — `_load_airtable_cross_check` reads that file once per
      batch run; `write_data_check` now populates `data_check.json`'s
      `airtable_cross_check` field from it (still `null` for an institution Airtable
      hasn't run against, or hasn't confirmed a URL for yet).
- [x] `jobs/01-discover/RUNBOOK.md` — added step 5.
- [x] Smoke check: `tests/test_phase12_discover_airtable.py` — monkeypatches
      `fetch_airtable_urls` so the test never makes a real API call, per the original
      "stubbed Airtable response" plan. Covers an exact match, a genuine mismatch
      (Airtable has a URL that differs), an institution Airtable has no row/URL for at
      all (correctly *not* counted as a mismatch), and confirms an unconfirmed
      institution is excluded from the cross-check entirely and `schools.csv` is never
      written to.

### Decisions made during Phase 12 (not asked separately — verified directly against the
live Airtable base rather than guessed)

- **Real field names confirmed against the live base**, not guessed from the old repo's
  field list: `UNITID`, `Transparency Report` (this base *also* has a `chtr_index_url`
  field, verified byte-for-byte identical to `Transparency Report` on every sampled row
  — read only the latter to avoid depending on two fields that might someday drift).
  `State`/`City, State` turned out to be linked-record fields (pointing at another
  table, not plain text), so the state-backfill BUILD_STATUS.md's Phase 6 notes flagged
  as a future possibility is **not** implemented here — it would need a second lookup
  against whatever table those linked records resolve to. Recorded as explicitly
  deferred, not silently dropped.
- **Match comparison is a plain stripped-string equality check**, not a normalized/fuzzy
  compare — simplest thing that could work, and the smoke check's mismatch case (a
  genuinely different path, not just a trailing-slash difference) is the realistic
  failure mode this guards against. Revisit if real-world false-mismatches from
  formatting differences turn out to be common.

## Phase 13 — done

`jobs/03-normalize/run.py` needed no code changes — it walks doc dirs for a missing
`extracted/text.txt` and is untouched by Phase 11's new `ledger/`/`data_check.json` files
living alongside it in the archive. `tests/test_phase3_normalize.py` re-run clean
(unchanged). Note: this test still exercises `lib/quotes.anchor_quote` directly — that's
expected to be removed in Phase 14 when `lib/quotes.py` itself is deleted; leaving it as
today's still-accurate baseline until then.

## Phase 14 — done

- [x] `lib/quotes.py` deleted entirely, along with `jobs/04-extract/crosscheck_prompt.md`
      (the second-pass cross-check concept only existed to route incidents into the now
      -removed `standard` tier — nothing references it anymore).
- [x] `jobs/04-extract/validate.py` rewritten: schema-conformance check only.
      `validation.json` is now `{schema_version: 2, valid, schema_errors}` — no
      anchoring, no tier, no `document`/`incidents` sub-results. Confirmed at this
      phase (not just asserted in the plan): organization matching and cross-year
      possible-match detection are **not** implemented here — per invariant 7 and
      `IMPLEMENTATION_PLAN.md` §9, both are derived by `06-publish/rebuild.py` at
      publish time, so Phase 14 really is just the extraction-side reshape as
      flagged last session; that logic now belongs to Phase 16.
- [x] `jobs/04-extract/prompt.md` rewritten for the v2 shape — organization name
      raw/normalized rules + tiebreaker priority order, the three alcohol/drugs source
      patterns and when to flag, `determination_status`, per-field date
      raw/normalized/precision, `extraction_confidence` (per-incident, correcting the
      document-level placement `DATABASE_SCHEMA.md` flagged as an open question), and
      the structured `flags[]` array.
- [x] `jobs/04-extract/make_packets.py` — bumped `PROMPT_VERSION` to `extract_v2`.
- [x] `jobs/04-extract/RUNBOOK.md` rewritten to match.
- [x] Smoke check: `tests/test_phase4_extract.py` rewritten in place (same job, same
      fixtures, reshaped assertions) — hand-authored v2 `incidents.json` for
      north-ridge (2 clean incidents with organization proposals), eastview's real
      CHTR PDF (1 incident carrying a hand-authored flag, proving flags survive
      schema validation), eastview's decoy PDF (deliberately schema-invalid — an
      unknown top-level field — proving invalid output still archives with
      `valid: false` and non-empty `schema_errors`, never silently discarded),
      westfield's scanned/nothing-readable case, and hillcrest's genuine
      zero-incident report. `tests/test_phase3_normalize.py` also updated to drop
      its now-dead `lib.quotes.anchor_quote` assertions (it imported the just-deleted
      module).

## Phase 15 — done

- [x] `jobs/05-review/ingest.py` rewritten: dropped `lib.quotes.anchor_quote`
      import and all re-anchoring-on-correction logic (nothing left to anchor
      against once quotes are gone), dropped `_resolved_decision`'s `second_review`
      merge (decision is read directly now). Added `CORRECTABLE_FIELDS` (20
      dot-path field names covering organization name fields, the three raw-text
      fields, alcohol/drugs/determination_status, and all 12 date sub-fields) and
      `_validate_corrections()`. Added a check that `organization_review is not
      None and incident_index is None` raises `IngestError`. No longer requires
      `extracted/text.txt` to exist at all (only the Pages UI still reads it, for
      navigation/highlighting).
- [x] Worker side (`jobs/05-review/app/worker/src/`): `types.ts` rewritten for the
      v2 shapes (`Flag`, `OrganizationType`, `AlcoholDrugs`, `DeterminationStatus`,
      `CorrectionEntry`, `OrganizationReview`, simplified `ValidationJson`).
      `reviewSchema.ts` rewritten (`DECISIONS` drops `escalated`; new
      `checkCorrections`/`checkOrganizationReview`) — caught and fixed a bug where
      `checkOrganizationReview` was called with the whole `review` object instead
      of `review.organization_review`. `ingest.ts` rewritten to match `ingest.py`
      exactly, dropping its `resolvedDecision` export.
- [x] `queue.ts` rewritten: dropped `QueueTier`/`TIER_ORDER`/`escalated_pending`
      entirely (decision is now final — a target with any matching review is just
      dropped from the queue, no partial-resolution state to track). Targets are
      now built directly from `incidentsJson.incidents` (each carrying its own
      `extraction_confidence`) instead of from `validation.json`'s old per-incident
      tier array, since `ValidationJson` no longer carries incident-level data.
      Ordering: by `docDir`, then `extraction_confidence` ascending (a
      document-level zero-incident target has no confidence of its own and sorts
      first via `?? -Infinity`) — per `IMPLEMENTATION_PLAN.md` §11's wording chosen
      during planning.
- [x] `src/quotes.ts` and `test/quotes.test.ts` deleted (the anchoring port has no
      caller left; `src/hashing.ts` kept as-is, still needed for `file_hash`).
      `index.ts` simplified: `handleReviewSubmit` no longer has a `second_review`
      stamping branch, just stamps `reviewer` at the top level unconditionally.
- [x] `test/queue.test.ts` and `test/ingest.test.ts` rewritten from scratch against
      the v2 fixture shapes (no more tier/escalation cases; added a
      "skips a document whose validation.json is invalid" case and an
      `organization_review` acceptance/rejection pair). `npm --prefix
      jobs/05-review/app/worker run typecheck` and `test` both clean (16 tests).
- [x] Pages UI (`app/pages/`) rewritten:
      - `app.js`: dropped tier badge/escalate button/keyboard shortcut entirely.
        Field rendering now shows organization type + all raw/normalized fields
        (declaratively, from small field-list tables, not one-off HTML per field)
        plus a `flags[]` list. Added a persistent "organization review" panel
        (decision + `corrected_organization_type`, populated from the 12-value
        enum) included in every submitted review's `organization_review`, disabled
        for document-level targets. Correction form rebuilt against
        `CORRECTABLE_FIELDS` exactly (text/textarea/enum/date-triple/date-pair
        rows), with one correction-type selector applied to every changed field in
        a submission (kept deliberately coarse — the schema's grain is per-field,
        but a per-field type picker in the form itself would be UI complexity this
        single-reviewer local tool doesn't need yet). Highlighting dropped its
        page-hint logic (no more page numbers anywhere in the new schema) — now a
        best-effort whole-page/whole-document text search against the raw fields,
        explicitly cosmetic only, same as before.
      - `index.html`: removed `tier-badge`/`escalated-badge`/escalate button, added
        `confidence-badge` and the `org-review-panel` markup.
      - `styles.css`: removed tier/escalate color variables and badge classes,
        added `confidence-high/mid/low` and organization-review-panel styles.
      - `config.js` needed no changes (workerBaseUrl only).
- [x] `jobs/05-review/RUNBOOK.md` rewritten throughout: no more
      tier/escalation/second_review/anchoring language; documents the new
      `CORRECTABLE_FIELDS`/`organization_review` shape, confidence-ordered queue,
      and that `extracted/text.txt` is no longer a hard precondition for
      `ingest_review()` itself.
- [x] Full smoke re-run, not just this phase's own tests: every
      `tests/test_phase*.py` (0, 2, 3, 4, 7a, 12) plus `npm --prefix
      jobs/05-review/app/worker test`/`run typecheck` all pass clean — confirms
      Phase 15's rewrite didn't regress any earlier phase.

Decisions made this phase (judgment calls, not asked separately — consistent with
the plan's own "phase-level implementation details are mine to decide" note):
- Organization review is captured on *every* submitted incident-level review
  (default `{decision: "approved", corrected_organization_type: null}` if the
  reviewer never touches the panel), rather than being its own separate
  submission/screen. Simpler for a single-reviewer tool, and `ingest.ts`/`ingest.py`
  already treat it as fully independent of the incident's own `decision`.
- A reviewed queue target is simply removed from `buildQueue()`'s output rather than
  carrying any "already decided" status field — v3.0 has no unresolved/pending
  state a decision can be in short of existing or not, so there's nothing left to
  surface a status enum for (unlike the old `escalated_pending`).

## Phase 16 — done

- [x] `jobs/06-publish/catalog_schema.sql` — rewritten from scratch: 15 tables across
      two schemas (`staging`: `staging_incidents`, `staging_organizations`,
      `staging_incident_possible_matches`, `staging_incident_review_flags`,
      `staging_incident_corrections`; `public`: `institution`, `pipeline_runs`,
      `data_checks`, `ledger`, `artifacts`, `incidents`, `incident_organizations`,
      `incident_dates`, `incident_status_history`, `organizations`), ordered as a
      topological sort of the FK graph rather than `DATABASE_SCHEMA.md`'s own table
      order (`staging.staging_incidents`/`staging_organizations` have to exist before
      `public.incidents`/`incident_organizations` can reference them; `public.incidents`
      has to exist before `staging.staging_incident_possible_matches` can reference it
      back). Enums are `text` + `CHECK`, matching the six-table schema's existing
      convention (no native Postgres `ENUM`). Verified by applying it to a scratch local
      Postgres database and confirming exactly 15 tables (10 `public` + 5 `staging`).
- [x] `jobs/06-publish/rebuild.py` — rewritten from scratch. `_populate()` walks the
      archive once, in FK-dependency order: `institution` (from `sources/schools.csv`)
      → `pipeline_runs` (from `pipeline_runs/*.json`, archive root, not prefix-scoped)
      → `data_checks` → `ledger` → `artifacts` → then, per doc dir in a deterministic
      `(unitid, scrape_year, fetched_at)` order, stages every `incidents[]` entry
      (regardless of review status) and — for `Approved` ones — promotes them per §9's
      organization-matching and cross-year status-update rules. See
      `jobs/06-publish/RUNBOOK.md` for the full walk-through.
- [x] `jobs/05-review/ingest.py` / `jobs/02-archive/run.py` / `schemas/data_check.schema.json`
      / `fixtures/schema_examples/data_check.example.json` — a real gap found while
      building this phase, fixed in place (see below): `data_check.json` had no
      `pipeline_run_id` field, so there was no way for `rebuild.py` to populate
      `Data_checks.pipeline_run_id` (a required FK per `DATABASE_SCHEMA.md`) at all.
      `write_data_check()` was already receiving `pipeline_run_id` as a parameter but
      explicitly discarding it (`_ = pipeline_run_id`, with a comment saying so). Added
      the field to the schema (required) and the example fixture, and now write_data_check
      actually stores it. `tests/test_phase2_archive.py` / `test_phase0_schemas.py` /
      `test_phase12_discover_airtable.py` all still pass after the change — this was a
      mechanical bug fix (matching invariant 3's "every artifact-writing script validates
      before writing" bar), not a new design decision.
- [x] Sanity-checked (not the formal Phase 17 smoke test, which still needs to be
      written): built a real archive via 02/03/04 against `fixtures/crawl_pages/` (same
      pattern `test_phase4_extract.py` uses), submitted `approved`/`corrected`/`rejected`
      reviews via `ingest.py`, hand-added a second-scrape-year re-extraction of the same
      eastview incident (same `investigation_end_date`, different `determination_status`)
      to exercise the one genuinely novel code path, and ran `rebuild.py` against a
      scratch local Postgres database. Confirmed: two full runs produce byte-identical
      row counts (idempotency); a `corrected` review's field correction lands in both
      `staging_incidents` and the promoted `incidents` row while leaving `incident_id`
      computed from the original extraction; a `rejected` incident never reaches
      `public.incidents`; `Required field missing`/`Low extraction confidence` flags are
      recomputed correctly from final field values; an AI-reported flag (`Determination
      unclear`) survives into `staging_incident_review_flags` when nothing corrected it;
      organization proposals get matched/promoted with the join table correctly
      populated; and, most importantly, the cross-year update case updates the existing
      public `incidents` row **in place** (no duplicate), writes one
      `incident_status_history` row with the right old/new status, keeps
      `incidents.staging_incident_id` frozen at the *original* promoting extraction (not
      repointed to the resolving one), and gives each of the two staging extractions
      (year 1 and year 2) its own `incident_dates` audit-trail row, both pointing at the
      same public `incident_id`. Caught and fixed one real bug in the process (see
      below). This round-trip is not a substitute for Phase 17's real fixture-based
      pytest suite — no automated test file was added this phase.
- [x] `jobs/06-publish/RUNBOOK.md` rewritten for the 15-table design.

### Bug found and fixed during Phase 16's sanity round-trip

`_process_organization()` read `org_review["reviewer"]` to populate
`staging_organizations.reviewed_by`, but `review.schema.json`'s `organization_review`
object only has `decision`/`corrected_organization_type` — it carries no `reviewer`
field of its own (it's a sub-decision on the same top-level review, not a separate
review). Every incident with an organization proposal and any `organization_review`
crashed with `KeyError: 'reviewer'`. Fixed by passing the top-level review's
`reviewer`/`reviewed_at` into `_process_organization()` explicitly instead of trying to
read them off the sub-object.

### Decisions made during Phase 16 (not asked separately — these were genuine
conflicts between `DATABASE_SCHEMA.md`'s literal field tables and either
`IMPLEMENTATION_PLAN.md` or the already-shipped v3.0 archive schemas, but each one
resolves cleanly by grounding in text `IMPLEMENTATION_PLAN.md` or the shipped schemas
already settle, rather than being genuinely open — same bar as every prior phase's
"not asked separately" notes)

- **ID strategy overrides `DATABASE_SCHEMA.md`'s "Integer, auto-generated" field-table
  wording entirely.** `DATABASE_SCHEMA.md` describes every primary key as
  auto-generated/`SERIAL`-style, but invariant 9 ("IDs are content-derived, never
  SERIAL... including every public ID") is unqualified, and `IMPLEMENTATION_PLAN.md`
  §12 explicitly gives content-derived hash formulas for `incident_id`/`organization_id`
  specifically, describing `DATABASE_SCHEMA.md` as authoritative only for "field-by-field
  reference," with §12 itself covering "what changed structurally." Resolved by treating
  §12 as the override: every primary key across all 15 tables is a
  `short_hash(sha256(...))` text id (matching the six-table schema's existing
  convention), computed from stable inputs (e.g. `staging_incident_id` = hash of
  `artifact_id` + incident index; `organization_id` = hash of the deterministic
  comparison key, not the first-seen proposal text, so it's idempotent regardless of
  processing order — directly per §12's own reasoning). `Institution.unitid` remains the
  one natural (non-hashed) key, per IPEDS.
- **Nullability conflicts resolved in favor of the already-shipped, enforced JSON
  schemas over `DATABASE_SCHEMA.md`'s field tables.** Three fields:
  `Institution.state_territory` (schema table says `NOT NULL`, but `sources/schools.csv`'s
  `state` column is blank for every row per Phase 6's decision — no IPEDS backfill has
  happened), `Staging_organizations.organization_type` (schema table says `NOT NULL`,
  but its own scope note instructs leaving it `NULL` when unclassifiable, and
  `jobs/04-extract/schema.json` already ships `organization_type` as nullable for
  exactly this reason), and `organization_name_raw`/`organization_name_normalized` /
  `Staging_incident_corrections.original_value` (schema tables say `NOT NULL`, but
  `jobs/04-extract/schema.json` and `schemas/review.schema.json` both allow null).
  All four left nullable in `catalog_schema.sql` — the alternative (`NOT NULL`) would
  make `rebuild.py` unable to insert real archived data at all.
- **`Staging_incident_review_flags` gets a DB-level `CHECK` enforcing "exactly one of
  staging_incident_id / staging_organization_id"**, even though `DATABASE_SCHEMA.md`
  describes this as pipeline-code-only enforcement. Not a contradiction — a stricter
  constraint than what's described doesn't violate the described behavior, and this
  schema is fully constrained throughout per the Phase 5 precedent ("NOT NULL wherever
  the source artifact schema requires the field... indexes on every FK column").
- **Flags are recomputed fresh every rebuild, never carried over as stored state**,
  per invariant 7 and `IMPLEMENTATION_PLAN.md` §9's explicit "recomputed by rebuild.py
  on every rebuild... not tracked as a separate stateful event." Two flag types
  (`Required field missing`, `Low extraction confidence`) are mechanically recomputed
  from the *final* (post-correction) field values every time. The other three
  (`Determination unclear`, `Alcohol/drugs review needed`, `Unrecognized date term`,
  `Unable to determine organization type`) depend on source-document structure only the
  AI observed, not any final scalar value, so they can't be mechanically re-derived —
  these are carried forward from the AI's own `incidents.json` `flags[]` array and
  dropped only when the reviewer's correction touched that exact field name (Review &
  Correction pipeline logic: "flags auto-clear when their condition resolves"). A direct
  consequence: `resolved_at` is always `NULL` in every rebuild — there's no stateful
  history to preserve across a full drop-and-rebuild architecture, so the column exists
  for schema fidelity with `DATABASE_SCHEMA.md` but is never actually populated.
- **Timestamp columns are derived from archived data, never wall-clock-at-rebuild-time**,
  with one accepted exception (`institution.created_at` — see `catalog_schema.sql`'s
  header and `RUNBOOK.md`'s postconditions for the full reasoning). This wasn't asked
  separately — it's a direct, low-judgment extension of invariant 9's "identical archive
  -> identical catalog" bar, which Phase 5's own smoke check already tested at full-row
  granularity ("every row and ID is byte-identical between the two runs"), not just IDs.
- **`data_check.json` gained a required `pipeline_run_id` field** (see the bug-fix note
  above) — a mechanical fix to close a real gap, not a design decision, but recorded
  here since it touches an already-shipped Phase 11 artifact schema.
- **`Artifacts.pipeline_run_id` (frozen-at-creation, per `DATABASE_SCHEMA.md`) is
  approximated, not exact.** Unlike `data_checks.pipeline_run_id` (now stored directly
  in `data_check.json`), `manifest.json` has no `pipeline_run_id` field of its own — that
  would require a second schema change to an artifact-writing script's output for a
  gap this phase judged non-blocking (it doesn't prevent a correct rebuild of any of the
  15 tables that actually matter for review/publish, only this one FK's exact accuracy
  under retries). `rebuild.py` approximates it by finding the pipeline run whose
  `[run_started_at, run_completed_at]` window brackets the artifact's `fetched_at`,
  falling back to the most recent run if none bracket cleanly. **Flagged as an open gap,
  not silently resolved**: if `Artifacts.pipeline_run_id`'s audit-trail accuracy under
  retried/partial runs ever matters (e.g. for debugging a specific bad extraction back
  to its exact producing run), `manifest.schema.json` needs its own `pipeline_run_id`
  field added the same way `data_check.schema.json` just got one.

## Next session should

Start Phase 17: build the new fixture archive + rewrite the official smoke test
(`tests/test_phase5_publish.py` → likely `tests/test_phase16_publish.py` or similar) —
Phase 16's sanity round-trip (a throwaway script, not committed) exercised the main
paths by hand but there is no automated regression coverage for `jobs/06-publish/`
yet. Cover at minimum: schema-invalid documents are skipped; a rejected incident never
reaches `public`; a `corrected` review's correction lands in both schemas while
`incident_id` stays computed from the original extraction; organization matching
(both "New proposal" and "Matched existing"); the cross-year "Status update to
existing incident" in-place-update path (the scenario this session's sanity check
built by hand — see Phase 16 notes); flag recomputation (both the mechanically
recomputed types and the carried-forward-then-cleared types); and full idempotency
(two rebuilds of an unchanged archive produce byte-identical rows). Also worth
deciding in Phase 17: whether to close the `Artifacts.pipeline_run_id` approximation
gap noted above by adding a `pipeline_run_id` field to `manifest.schema.json`, mirroring
the `data_check.schema.json` fix this phase already made.

Still separately open, unrelated to the v3.0 migration: Phase 7b's live deploy (real
review-app R2 write credentials scoped to `reviews/`, a Cloudflare Access application,
`config.js` pointed at the deployed Worker) — needed before any volunteer can actually
use the review app.
