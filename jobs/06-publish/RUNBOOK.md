# 06-publish

## Purpose

Rebuild the catalog (Neon Postgres) from the archive. R2 is the sole source of truth and
Postgres is a disposable projection, so this job never updates a live database
incrementally: every run drops both the `staging` and `public` schemas, recreates them
from `catalog_schema.sql`, and repopulates all 15 tables from a full walk of the
archive. Run it after every review batch.

`staging` holds every AI-extracted candidate incident/organization, regardless of
review status (`human_review_status`: `Pending review` / `Approved` / `Rejected`).
`public` holds only what an `Approved` (or corrected-and-`Approved`) decision promoted.
See `DATABASE_SCHEMA.md` for the authoritative field-by-field reference and `CLAUDE.md`
for the review/matching/promotion model.

## Preconditions

- `NEON_DATABASE_URL` is set (real Neon for a production run; any Postgres the
  operator controls for a local/fixtures run — `catalog_schema.sql` has no
  Neon-specific SQL).
- `sources/schools.csv` exists (`institution` table is empty otherwise).
- The archive has at least one document; an empty archive still produces a valid,
  empty catalog.

## Steps

1. Run: `python jobs/06-publish/rebuild.py` (optionally `--prefix archive/` to target
   a non-default archive prefix, e.g. `smoke/` for the fixtures smoke run).
2. The script, inside one transaction:
   - `DROP SCHEMA IF EXISTS staging CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA
     public;`, then applies `catalog_schema.sql` (which itself `CREATE SCHEMA
     staging;`s and creates all 15 tables, in FK-dependency order).
   - Populates `institution` from every row of `sources/schools.csv`.
   - Populates `pipeline_runs` from every `pipeline_runs/{run_id}.json` (archive root,
     not prefix-scoped — matches where `02-archive/run.py` writes them).
   - Populates `data_checks` from every `{prefix}/{inst}/{year}/data_check.json`.
   - Populates `ledger` from every `{prefix}/{inst}/ledger/{url_hash16}.json`.
   - Populates `artifacts` from every doc dir with a `manifest.json` (one row per
     unique captured snapshot — `02-archive` already dedupes unchanged content at
     write time, so this is naturally 1:1 with distinct doc dirs).
   - Walks every doc dir's *current* `extract_v{N}/incidents.json` (skipping any whose
     `validation.json` is `valid: false`), **in a deterministic order** — grouped by
     `unitid`, ordered by `scrape_year` then `fetched_at` within it — so an earlier
     report's incidents are staged and (if approved) promoted before a later
     re-scrape of the same institution can match against them:
     - One `staging_incidents` row per `incidents[]` entry, regardless of review
       status. If a `reviews/*.review.json` matches (by `extraction_ref.file_hash` +
       `.incident_index`), its `decision` sets `human_review_status`
       (`approved`/`corrected` → `Approved`, `rejected` → `Rejected`); no matching
       review leaves it `Pending review`. A `corrected` review's `corrections[]` are
       applied to a copy of the raw extraction before anything is stored — the *raw*
       extraction is still used to compute `incident_id` (corrections never change an
       incident's public id), and every applied field is logged to
       `staging_incident_corrections`.
     - One `staging_organizations` row per incident that names an organization
       (`organization_name_raw` not null) — matched against already-*approved*
       organizations seen so far in this same rebuild via a deterministic
       lowercase/trim/punctuation-stripped comparison key. An incident naming no
       organization gets no `staging_organizations`/`incident_organizations` row.
     - `staging_incident_review_flags` are recomputed fresh every rebuild, never
       carried over as stored state: `Required field missing` and `Low
       extraction confidence` (<0.7, provisional) are checked mechanically against
       the *final* (post-correction) field values; the remaining flag types
       (`Determination unclear`, `Alcohol/drugs review needed`, `Unrecognized date
       term`, `Unable to determine organization type`) are carried forward from the
       AI's own `incidents.json` `flags[]` unless the reviewer's correction touched
       that exact field, in which case the condition is treated as resolved and
       dropped.
     - For an `Approved` incident: looks up already-*public* incidents for the same
       `unitid` by two keys — `investigation_end_date` (primary) or
       `(organization comparison key, incident_start_normalized)` (secondary, catches
       `Pending` incidents with no end date yet). A hit writes a
       `staging_incident_possible_matches` row (`match_basis` = `Duplicate match` if
       `determination_status` is unchanged, else `Status update to existing
       incident`). `Duplicate match` (or no hit) inserts a new `incidents` row.
       `Status update to existing incident` instead updates the existing `incidents`
       row's `determination_status`/`updated_at` **in place** and inserts one
       `incident_status_history` row — `incidents.staging_incident_id` stays frozen at
       whichever extraction *first* promoted that row; the resolving extraction is
       recorded only via `incident_status_history.staging_incident_id`.
     - `incident_dates`/`incident_organizations` get one row per staged incident
       always (`staging_incident_id` always set), with `incident_id`/`organization_id`
       populated only once/if that staging incident resolves to a promotion — so a
       `Status update` case still gets its own `incident_dates` row, pointing at the
       *existing* (not a new) public incident, preserving a per-extraction audit
       trail even though the public row itself wasn't duplicated.
   - Commits once the whole walk succeeds.

## Postconditions

- All 15 tables (`institution`, `pipeline_runs`, `data_checks`, `ledger`, `artifacts`,
  `incidents`, `incident_organizations`, `incident_dates`, `incident_status_history`,
  `organizations` in `public`; `staging_incidents`, `staging_organizations`,
  `staging_incident_possible_matches`, `staging_incident_review_flags`,
  `staging_incident_corrections` in `staging`) exactly reflect the archive as of the
  run.
- Every id (`incident_id`, `organization_id`, `staging_incident_id`, `artifact_id`,
  `ledger_id`, ...) is a content-derived hash, identical to the previous run's,
  provided the archive is unchanged — corrections change what's stored in a row, never
  its id.
- **Known, accepted exception:** `institution.created_at` is *not* reproducible across
  separate rebuild invocations — `sources/schools.csv` carries no "institution first
  tracked" timestamp, so this one column is stamped with the rebuild's own wall-clock
  time (a single value per run, not per row). Every other timestamp column is derived
  from a timestamp already recorded in some archived JSON file, so it *is* reproducible.

## Failure modes

- A single incident's staging/promotion failing (e.g. a `corrections[]` entry naming
  a field outside `rebuild.py`'s `CORRECTABLE_FIELDS`) is logged and that incident is
  skipped — it does not abort the whole rebuild, since every other row is still a
  faithful read of the archive.
- Any failure before the final commit rolls back the whole run — the catalog is never
  left half-populated. A crashed or interrupted rebuild is safe to simply re-run (it
  is a pure function of the archive, so nothing needs cleaning up first).
- A `data_checks` row with no matching `pipeline_runs` row (shouldn't happen —
  `02-archive/run.py` always writes `data_check.json`'s `pipeline_run_id` from a run
  it just started) would fail its FK constraint and abort the transaction; this is a
  real bug signal, not an expected/tolerated case.
