# 05-review

## Purpose

Write a human reviewer's decision (`review.json`) to the archive, synchronously at
decision time, per Section 10/11. This is the only script in the pipeline that writes
under `{doc_dir}/reviews/` — it is deliberately the sole gate between "a reviewer
clicked approve/correct/reject in the app" and a fact landing in the immutable
archive, since `06-publish/rebuild.py` later trusts whatever it finds there without
re-validating.

**This phase (7a) ships `ingest.py` as pure, locally-testable Python.** There is no
live Cloudflare Worker, wrangler project, or Access login yet — no real R2/Cloudflare
credentials exist in `.env` (confirmed with the user). Once the review UI (Phase 7b)
and real credentials exist, a Cloudflare Worker will call this same validation logic
(ported to TypeScript, since Workers can't run Python) sitting behind Cloudflare
Access; `ingest_review()` is written so that porting is mechanical — it has no
side effects beyond `lib/r2.py` calls and raises on every failure mode rather than
returning a partial result.

## Preconditions

- The document at `doc_dir` has gone through 04-extract: at least one
  `{doc_dir}/ai/extract_v{N}/incidents.json` exists, and `{doc_dir}/extracted/text.txt`
  exists (needed to re-anchor corrections).
- No write credentials are required from the agent — set `ARCHIVE_LOCAL_ROOT` for a
  local/fixtures run, or the `R2_*` env vars for a real run (same switch every other
  job uses).
- The caller (a future Worker, a test, or this RUNBOOK's manual step) already knows
  `doc_dir` — review.json itself only carries `extraction_ref.file_hash` +
  `incident_index`, not which document that extraction belongs to. In the real app
  this comes from the catalog's queue view (`documents.storage_key`, Section 12).

## Steps

1. Run: `python jobs/05-review/ingest.py --doc-dir <archive path> --review <path to a
   review.json file>` — or call `ingest_review(doc_dir, review_json)` directly (this is
   what a future Worker embeds).
2. `ingest_review` does, in order, never partially writing:
   - Validates the review against `schemas/review.schema.json`.
   - Confirms `extraction_ref.file_hash` matches the sha256 of some
     `ai/extract_v{N}/incidents.json` under `doc_dir` (searches every version, not
     just the current one — a review may target an older extraction than whatever is
     "current" now; invariant 9).
   - Confirms `extraction_ref.incident_index` is in range for that extraction.
   - If the resolved decision (second_review's decision wins over the first's, same
     rule `06-publish/rebuild.py` uses at read time) is `corrected`: re-anchors every
     quote-bearing field (`organization_quote`, `description_quote`, `findings_quote`,
     `dates.incident_quote`) a correction touches against `extracted/text.txt` via
     `lib.quotes.anchor_quote`. Any corrected quote that doesn't anchor rejects the
     whole review — nothing is written.
   - Writes to `{doc_dir}/reviews/{incident_index}_{reviewer-slug}_{ts}.review.json`.

## Postconditions

- A validated, hash-pinned `review.json` exists under `{doc_dir}/reviews/`, ready for
  `06-publish/rebuild.py` to pick up on the next rebuild.
- The archive is never overwritten: a second decision for the same incident (e.g. a
  dual-review resolution embedding `second_review`) is a *new* file with a later
  `reviewed_at` — `rebuild.py` already picks the latest-`reviewed_at` match per
  `(file_hash, incident_index)`.

## Failure modes

- Any of schema validation, hash-pinning, range-checking, or re-anchoring failing
  raises `IngestError` (or exits 1 from the CLI) and writes nothing — a rejected
  review never partially lands in the archive. The caller (eventually: the Worker,
  returning an error to the review app) is responsible for surfacing this to the
  reviewer so they can fix the correction and resubmit.
- `reviewer` is trusted as given — Section 11's "identity from the Access JWT" isn't
  enforced by this script this phase (confirmed with the user, since Access isn't
  wired up yet). Verifying it against a real signed identity is the future Worker's
  job, not `ingest.py`'s.
