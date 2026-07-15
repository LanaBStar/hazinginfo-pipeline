# migration

One-time migration from the legacy HazingInfo system (`~/Documents/hazing-incidents/`,
frozen read-only reference at `reference/`). Two independent scripts; run
`backfill_manifests.py` before `export_legacy.py` (the second depends on documents the
first has already copied into the new archive). Neither script ever writes to the old
system — both open the old Neon connection with `conn.read_only = True`.

## Purpose

- `backfill_manifests.py`: copies every document the old system ever captured
  (`raw_artifacts`) into the new archive's `manifest.json` + `original/` layout, without
  ever re-fetching the source page. The old captures are the only copy that will ever
  exist of pages that may since have changed or vanished.
- `export_legacy.py`: exports the old system's human-verified `incidents` rows as a
  reference answer-key (`migration/calibration_set.json`) pointing at the now-backfilled
  documents. These old fields are never imported as catalog data (no quotes, no anchors —
  they don't meet the new evidentiary standard); the documents get re-extracted from
  scratch under the new schema like any other document, and volunteer reviewers are
  calibrated by comparing their independent read against this answer-key.

## Preconditions

- `OLD_DATABASE_URL` set to the old system's Neon connection string (read-only role, or
  any role — the script self-restricts to read-only at the transaction level regardless).
- `OLD_R2_ENDPOINT_URL` / `OLD_R2_ACCESS_KEY_ID` / `OLD_R2_SECRET_ACCESS_KEY` /
  `OLD_R2_BUCKET_NAME` set to the old system's R2 credentials — or `OLD_ARCHIVE_LOCAL_ROOT`
  pointed at a local directory mirroring the old bucket's key layout, for a local/fixtures
  run (same pattern as every other job's `ARCHIVE_LOCAL_ROOT`).
- The new system's own `R2_*` / `ARCHIVE_LOCAL_ROOT` set as usual — this is where both
  scripts write.
- `sources/schools.csv` populated (01-discover/Phase 6) — an old-system institution no
  longer present there is skipped, not migrated under a guessed slug.
- `export_legacy.py` additionally requires `backfill_manifests.py` to have already run for
  the documents its legacy incidents point at.

## Steps

1. `python migration/backfill_manifests.py [--old-db-url ...] [--schools-csv PATH]`
   - Walks every `raw_artifacts` row (joined to `institutions` for unitid/name).
   - Skips a row whose target `manifest.json` already exists (resumable/idempotent).
   - Skips a row whose unitid isn't in the current `sources/schools.csv`.
   - Fetches the object's bytes from the old R2 bucket by its recorded `storage_key`,
     verifies the bytes hash to the `content_hash` Neon recorded, and only then writes
     `original/{report.pdf|index.html}` + `manifest.json` into the new archive at
     `archive/{unitid}_{slug}/{scrape_year}/docs/{hash16}/`, where `scrape_year` is the
     year `raw_artifacts.scraped_at` falls in.
   - Does **not** write `status.json` for these institution-years (Section 13 names this
     script's deliverable as manifest.json specifically) — see BUILD_STATUS.md for the
     consequence (these years won't appear in `reporting_status` / `status.py`'s counts,
     but the documents themselves populate `documents` normally once published).
2. Run the normal pipeline over the backfilled documents to bring them to the same state
   as any newly archived one: `python jobs/03-normalize/run.py`, then 04-extract's
   `make_packets.py` / agent extraction / `validate.py`, same as any other document.
3. `python migration/export_legacy.py [--old-db-url ...] [--schools-csv PATH] [--out PATH]`
   - Walks every old `incidents` row (joined through `chtr_reports` to `institutions` and
     `raw_artifacts` for the `content_hash` that locates its now-backfilled `doc_dir`).
   - Skips a row whose institution isn't in the current `sources/schools.csv`, whose
     `chtr_reports.artifact_id` was never set (no source document to point at), or whose
     document `backfill_manifests.py` hasn't copied in yet.
   - Writes `migration/calibration_set.json` (gitignored — contains real organizations'
     names and incident descriptions) validated against
     `migration/calibration_set.schema.json`.
4. Hand `migration/calibration_set.json` to the volunteer calibration process (Section 9):
   reviewers independently review the documents it points at; agreement with the
   `legacy_fields` answer-key and with each other determines whether single-review on the
   `standard` tier is safe.

## Postconditions

- Every old `raw_artifacts` row has either a `manifest.json` in the new archive or a
  logged skip reason (`skipped_unknown_institution`, `failed`, `failed_hash_mismatch`).
- `migration/calibration_set.json` exists locally, one entry per successfully exported
  legacy incident, each `doc_dir` resolving to a real document in the new archive.

## Failure modes

- A single row's fetch/hash-mismatch/unexpected error is caught, logged, and counted —
  it does not abort the run for the remaining rows (same per-item exception handling as
  every other job in this codebase).
- A content hash mismatch between old Neon's `content_hash` and the bytes actually fetched
  from old R2 is never written to the new archive under any circumstance — better a
  document is missing (and re-run later once investigated) than silently wrong.
- Both scripts are read-only against the old system at the Postgres transaction level
  (`conn.read_only = True`); an old Neon connection that somehow attempted a write would
  raise, not silently succeed.
