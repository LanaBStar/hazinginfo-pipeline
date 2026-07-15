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
| 8 | migration/: backfill_manifests.py + export_legacy.py | done | Smoke check passes (`.venv/bin/python tests/test_phase8_migration.py`) |

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

## Phase 8 — done

- [x] `migration/old_r2.py` — read-only client for the OLD system's R2 bucket. Mirrors
      `lib/r2.py`'s local-fallback pattern (`OLD_ARCHIVE_LOCAL_ROOT` instead of
      `ARCHIVE_LOCAL_ROOT`) so tests run against a fixture directory with no live
      credentials. Deliberately has no `put_bytes` — migration must never write to the
      old system.
- [x] `migration/backfill_manifests.py` — walks the old Neon `raw_artifacts` table
      (joined to `institutions` for unitid/name), fetches each object's bytes from the
      old R2 bucket by its recorded `storage_key`, verifies the bytes hash to the
      `content_hash` Neon recorded, and writes `manifest.json` + `original/{filename}`
      into the new archive at `archive/{unitid}_{slug}/{scrape_year}/docs/{hash16}/` —
      same shape and same `_slug()`/filename/content-type conventions
      `jobs/02-archive/run.py`'s `store_document()` already uses (duplicated, not
      imported, so the two inst_dir derivations can never silently drift apart). Never
      re-fetches a source URL. The old Neon connection is opened `read_only = True` at
      the transaction level — a real Postgres-enforced backstop, verified in this
      phase's smoke check (a `DELETE` against it raises `ReadOnlySqlTransaction`).
      Idempotent/resumable (per the user's confirmed choice — see below): a raw_artifacts
      row whose target `manifest.json` already exists is skipped. A row whose unitid
      isn't in the current `sources/schools.csv`, or whose fetched bytes don't hash to
      the recorded `content_hash`, is skipped and logged rather than aborting the run;
      a hash mismatch is never written under any circumstance.
- [x] `migration/calibration_set.schema.json` — new schema (job-local, same placement
      rule as `jobs/01-discover/schema.json`) for the volunteer calibration set, per
      the shape confirmed with the user (see below).
- [x] `migration/export_legacy.py` — walks the old Neon `incidents` table (Tier 6,
      human-approved, joined through `chtr_reports` to `institutions` and
      `raw_artifacts` for the `content_hash` that locates its now-backfilled `doc_dir`),
      and writes `migration/calibration_set.json`: one entry per legacy incident whose
      institution is still tracked and whose source document `backfill_manifests.py`
      has already copied in, pairing `doc_dir` with the legacy incident's old fields as
      a reference answer-key. Never imports old fields as catalog data — they have no
      quotes/anchors and don't meet the new evidentiary standard. Same read-only-Neon
      guarantee as `backfill_manifests.py`.
- [x] `migration/RUNBOOK.md` — purpose/preconditions/steps/postconditions/failure modes
      for both scripts, including the required run order (backfill before export, with
      normal 03-normalize/04-extract re-extraction of the backfilled documents in
      between).
- [x] `.env.example` — added `OLD_R2_ENDPOINT_URL`/`OLD_R2_ACCESS_KEY_ID`/
      `OLD_R2_SECRET_ACCESS_KEY`/`OLD_R2_BUCKET_NAME`/`OLD_DATABASE_URL`, placeholder
      values only, same naming convention as the existing `R2_*`/`NEON_DATABASE_URL`.
- [x] `.gitignore` — added `migration/calibration_set.json` (real organizations' names
      and incident descriptions from the old system; not an archive artifact, not for
      version control, same reasoning as `.env`).
- [x] Smoke check: `tests/test_phase8_migration.py` — a scratch Postgres database seeded
      with a faithful subset of the real old schema (copied from
      `~/Documents/hazing-incidents/scraper/db.py`: `institutions`, `pipeline_runs`,
      `raw_artifacts`, `chtr_reports`, `incidents`) plus a local directory standing in
      for the old R2 bucket (`OLD_ARCHIVE_LOCAL_ROOT`) — the synthetic-fixture approach
      the user chose over a live old-system connection this session. Three old
      `raw_artifacts` rows exercise every branch: Northgate University (correct hash,
      known institution — the happy path, backfilled then exported), Old Removed
      College (correct hash, but not in the current `sources/schools.csv` — skipped by
      both scripts), and Fernwood State (content_hash deliberately does not match the
      real bytes at its storage_key — `backfill_manifests.py` refuses to write it, and
      `export_legacy.py`'s legacy incident pointing at it correctly reports
      `skipped_not_backfilled`, proving the two scripts' failure paths compose). A
      fourth legacy incident with `artifact_id = NULL` exercises `skipped_no_document`.
      Asserts manifest.json/original bytes are byte-correct, `backfill_manifests.py` is
      resumable (run twice, second run backfills 0 new documents), and
      `calibration_set.json` validates against its own schema. All 8 prior phases'
      Python smoke checks (`tests/test_phase0..7b*.py`) and the Worker's `npm test` (26
      cases) re-run clean afterward.

### Decisions made during Phase 8 (asked the user, since the plan was silent/ambiguous here)

- **Old-system credentials weren't available this session.** Confirmed with the user:
  build and smoke-test against a synthetic fixture (as above) rather than the real old
  R2/Neon, matching every prior phase's local-fixture pattern. The real
  `OLD_R2_*`/`OLD_DATABASE_URL` values, and a run of both scripts against the actual old
  system, are left for a follow-up session once the user hands them over — see "Next
  session should" below. The old Neon schema itself was *not* an open question this
  phase (unlike the plan's framing suggested it might be): `~/Documents/hazing-incidents/
  scraper/db.py` (read, never modified — allowed per IMPLEMENTATION_PLAN.md §0, the same
  old repo `reference/` mirrors a subset of) has the exact `CREATE TABLE` statements for
  `raw_artifacts`, `institutions`, `chtr_reports`, and the human-verified `incidents`
  table, so the column mapping was read directly rather than guessed or asked about.
- **Resumability:** confirmed with the user — `backfill_manifests.py` follows invariant
  10 like every other job (skip a row whose manifest.json already exists) rather than
  being a true one-time, non-resumable script. Costs one `r2.exists()` check per row.
- **`calibration_set.json`'s shape**: confirmed with the user — the proposal in this
  session's question (top-level `{schema_version, calibration_set: [{legacy_incident_id,
  unitid, doc_dir, legacy_fields: {...}}]}`, with `legacy_fields` covering every column
  the old `incidents` table's Tier 6 verified row carries) was accepted as-is.
- **`backfill_manifests.py` does not write `status.json`** (not asked separately — a
  direct reading of §13's literal scope, which names only manifest.json as this script's
  deliverable, unlike §7's 02-archive spec which explicitly calls out status.json
  including the not_found/no_url cases). Consequence: backfilled institution-years won't
  appear in `06-publish`'s `reporting_status` table or in `status.py`'s counts. This
  doesn't block re-extraction/review/publish of the backfilled documents themselves —
  `rebuild.py`'s `documents`/`reports`/`incidents` population all walk for `manifest.json`
  directly, never `status.json`. Revisit if `status.py`/the operator console ever needs
  visibility into backfilled-but-not-yet-status-tracked institution-years.
- **Original document bytes are copied into the new archive's `original/`, not just
  referenced** (not asked separately — a direct consequence of invariant 1 and the 2036
  test: a `manifest.json` with no corresponding `original/` file isn't self-contained,
  and 03-normalize needs the bytes present in the *new* archive to produce
  `extracted/text.txt` for these documents like any other).

## Next session should

Nothing is blocking — all 9 build phases (0 through 8) are done, and the 2036 test
(§17) should be re-validated end-to-end against a real annual pass once real
credentials exist for both systems. Two credential hand-offs are still open, both
deliberately deferred rather than blocking their phases:

- **Phase 7b's live deploy** (still open from that phase): real R2 write credentials
  scoped to `reviews/`, a Cloudflare Access application gating the Worker's route, and
  `config.js` pointed at the deployed Worker, whenever the user is ready to hand over
  credentials.
- **Phase 8's real migration run** (this session): `OLD_R2_ENDPOINT_URL` /
  `OLD_R2_ACCESS_KEY_ID` / `OLD_R2_SECRET_ACCESS_KEY` / `OLD_R2_BUCKET_NAME` /
  `OLD_DATABASE_URL` for the actual old system, so `migration/backfill_manifests.py`
  then `migration/export_legacy.py` can be run for real (read-only against the old
  system throughout) instead of just against this phase's synthetic fixture. Once run,
  follow `migration/RUNBOOK.md` step 2 (03-normalize + 04-extract over the newly
  backfilled documents) before treating the calibration set as ready for volunteer use.
