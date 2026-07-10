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

## Next session should

Start Phase 5: 06-publish (`catalog_schema.sql` + `rebuild.py`), per
IMPLEMENTATION_PLAN.md §12/§16. Smoke check per §16: rebuild twice against the fixtures
archive → byte-identical ids both times; the fixture incidents from Phase 4's smoke
archive appear in the catalog. Note Phase 4 left the cross-check second pass
unwired — `rebuild.py` should not assume any incident will ever be `standard` yet, and
should read `document.tier`/`document.flagged_reasons` (new in Phase 4) for the
zero-incident-report case rather than expecting every reviewable unit to live in
`incidents[]`.
