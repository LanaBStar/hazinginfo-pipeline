# 06-publish

## Purpose

Rebuild the public catalog (Neon Postgres) from the archive. Per invariant 1 (R2 is
the sole source of truth; Postgres is a disposable projection) and invariant 2
(rebuild is the only write path — no incremental import), this job never updates
existing rows: every run drops the `public` schema, recreates it from
`catalog_schema.sql`, and repopulates every table from a full walk of the archive.
Run it after every review batch.

## Preconditions

- `NEON_DATABASE_URL` is set (real Neon for a production run; any Postgres the
  operator controls for a local/fixtures run — `catalog_schema.sql` has no
  Neon-specific SQL).
- `sources/schools.csv` exists (institutions table is empty otherwise).
- The archive has at least one document; an empty archive still produces a valid,
  empty catalog.

## Steps

1. Run: `python jobs/06-publish/rebuild.py` (optionally `--prefix archive/` to target
   a non-default archive prefix, e.g. `smoke/` for the fixtures smoke run).
2. The script, inside one transaction:
   - `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, then applies
     `catalog_schema.sql`.
   - Populates `institutions` from every row of `sources/schools.csv`.
   - Populates `reporting_status` from every `status.json`.
   - Populates `documents` from every `manifest.json`.
   - For every document with a current-version `incidents.json` + `validation.json`
     that passed schema validation: matches each `incidents[]` entry against
     `reviews/*.review.json` by `extraction_ref.file_hash` (sha256 of that
     `incidents.json`) + `extraction_ref.incident_index`. An incident with no
     matching review, or a `rejected` one, is skipped. An `approved`/`corrected`
     incident gets a row in `incidents` (and `reports`, created once per document on
     its first qualifying incident) — corrections are applied to the field they name
     before the row is written; a `second_review`, if present, applies after the
     first and wins on any field both name.
   - Commits once the whole walk succeeds.

## Postconditions

- The catalog's six tables (`institutions`, `documents`, `reports`, `incidents`,
  `incident_sanctions`, `reporting_status`) exactly reflect the archive as of the run.
- Every `incident_id` / `report_id` is identical to the previous run's, provided the
  archive is unchanged (invariant 9) — corrections change what's stored in a row,
  never its ID, since IDs are computed from the original, uncorrected extraction.
- `status.py`'s `publish.last_rebuild` / `publish.approved_unpublished` reflect the
  run (via `catalog/last_rebuild.json`, written separately — see `status.py`).

## Failure modes

- A single incident's correction failing to apply (e.g. a `corrections` path outside
  the supported vocabulary in `rebuild.py`'s `CORRECTION_FIELDS`) is logged and that
  incident is skipped — it does not abort the whole rebuild or roll back the
  transaction, since every other row is still a faithful read of the archive.
- Any failure before the final commit rolls back the whole run — the catalog is
  never left half-populated. A crashed or interrupted rebuild is safe to simply
  re-run (it is a pure function of the archive, so nothing needs cleaning up first).
- Zero-incident ("fast" tier) reports are out of scope this phase (no `reports` row
  is produced for them yet — see `BUILD_STATUS.md`'s Phase 5 notes); this is not a
  failure, just an unimplemented case for a later phase.
