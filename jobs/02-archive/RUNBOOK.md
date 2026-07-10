# 02-archive

## Purpose

Fetch every institution's CHTR original(s) from the web and preserve them permanently in
R2, before any AI runs. No relevance judgment happens here — the crawl archives every
document that could plausibly be a CHTR (keyword heuristics only); 04-extract's `is_chtr`
field is the actual classification. Writes one `manifest.json` per document and one
`status.json` per institution-year (§6), including the `not_found` / `no_url` cases —
absence is data (invariant 8).

## Preconditions

- `sources/schools.csv` exists and has at least one row with `url_status=confirmed` and a
  non-empty `chtr_url` (produced by 01-discover; until that phase exists, use a hand-made
  CSV in the same shape for the fixtures smoke run).
- No write credentials are required from the agent — this is a plain Python script; set
  `ARCHIVE_LOCAL_ROOT` for a local/fixtures run, or the `R2_*` env vars for a real run.

## Steps

1. Run: `python jobs/02-archive/run.py` (optionally `--schools-csv PATH` and `--year YYYY`
   for a non-default scrape year or CSV location; the smoke run uses both).
2. For every row in `schools.csv`:
   - Skip immediately if `archive/{unitid}_{slug}/{year}/status.json` already exists
     (resumable — this is what makes annual re-runs and interrupted runs safe).
   - `url_status == "no_url"` → write `status.json` with `status: "no_url"`, no fetch.
   - `url_status == "confirmed"` with a `chtr_url` → crawl (breadth-first, depth <= 2,
     ~30-fetch budget, same-domain links prioritized, all PDFs on hazing-signal pages
     followed — ported from `reference/scrape.py`). Every stored document gets a
     `manifest.json` validated against `schemas/manifest.schema.json` before writing.
     `status.json` gets `status: "published"` (>=1 document stored or found already
     archived from a prior year) or `status: "not_found"` (crawl found nothing —
     covers both fetch failure and no hazing signal anywhere), validated against
     `schemas/status.schema.json`.
   - Any other `url_status` (e.g. `pending`, not yet confirmed by discover) → skip with no
     write; not yet actionable.
3. Dedup: before storing a document, the run checks every year already archived for that
   institution for a matching content-hash directory; an unchanged document is never
   re-fetched-and-stored twice, only re-referenced in the new year's `status.json`.

## Postconditions

- Every institution with a confirmed URL or a recorded `no_url` has a `status.json` for
  the current scrape year.
- Every stored document has `manifest.json` + the original bytes under
  `docs/{hash[:16]}/original/`.
- `status.py`'s `archive.institutions_done` / `archive.documents` counts reflect the run.

## Failure modes

- A single institution's fetch/crawl exception must not abort the whole run — catch, log,
  and treat as `not_found` for that institution so subsequent institutions still process
  (network flakiness against ~1,484 live university sites is expected).
- A document that validates against `manifest.schema.json` but was already partially
  written (crash mid-run) is safe to re-run: dedup keys off content hash, and `status.json`
  for that institution-year is only written once the whole crawl completes, so a crash
  before that point simply gets re-attempted on the next run (no partial `status.json` is
  ever visible).
- `published_zero` is never written by this job — it requires reading document content
  (an explicit zero-incident statement), which is only knowable at 04-extract time.
