# Build Status

Tracks progress against the phases defined in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §16.
Update this file at the end of every work session so a fresh session can resume with zero
conversational context.

| Phase | Deliverable | Status | Notes |
|---|---|---|---|
| 0 | Repo scaffold, CLAUDE.md/AGENTS.md, OPERATIONS.md, all JSON schemas, BUILD_STATUS.md, fixtures/ | done | Smoke check passes (`.venv/bin/python tests/test_phase0_schemas.py`) |
| 1 | `status.py` + `lib/` (r2, hashing, fetch, text) | not_started | |
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

## Next session should

Start Phase 1: `status.py` + `lib/` (r2, hashing, fetch, text), per IMPLEMENTATION_PLAN.md
§16. Smoke check: correct JSON against a hand-made mini archive.
