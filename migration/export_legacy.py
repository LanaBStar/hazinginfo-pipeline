"""export_legacy.py -- migration/: export previously human-verified legacy incidents as
the volunteer calibration set.

Per IMPLEMENTATION_PLAN.md Section 13, item 2 / Section 9. The old system's `incidents`
table (Tier 6: human-approved, promoted from staging) does NOT meet the new evidentiary
standard -- its fields are free text with no verbatim quote/page anchor -- so none of it
is imported as catalog data. Instead, each legacy incident's source document (already
copied into the new archive by migration/backfill_manifests.py, which must run first) is
re-extracted from scratch under the new schema like any other document, and the legacy
incident's old fields become a reference answer-key: before trusting single review,
volunteers independently re-extract/review these same documents and their agreement with
the legacy answer (and each other) is what calibrates the reviewer pool.

Reads only: no old-system writes, same `conn.read_only = True` backstop as
backfill_manifests.py. Writes migration/calibration_set.json (validated against
migration/calibration_set.schema.json) to the local filesystem, not R2 -- this is a
migration/reviewer-training deliverable, not an archive artifact per IMPLEMENTATION_PLAN.md
Section 6, and it names real organizations and incident descriptions, so it's gitignored
(see .gitignore) same as .env.

A legacy incident whose institution no longer exists in the current sources/schools.csv,
whose chtr_reports row has no linked raw_artifacts (artifact_id is null in the old
schema -- no source document to point at), or whose document backfill_manifests.py hasn't
(yet) copied into the new archive is skipped with a warning rather than aborting the
whole export, matching every other job's per-item exception handling in this codebase.

Run: python migration/export_legacy.py [--old-db-url ...] [--schools-csv PATH] [--out PATH]
"""
import argparse
import csv
import json
import logging
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402
import jsonschema  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import short_hash  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
DEFAULT_OUT = JOB_DIR / "calibration_set.json"
ARCHIVE_PREFIX = "archive"
CALIBRATION_SCHEMA = json.loads((JOB_DIR / "calibration_set.schema.json").read_text())

LEGACY_INCIDENTS_QUERY = """
    SELECT inc.id AS legacy_incident_id, i.unitid, ra.content_hash, ra.scraped_at,
           inc.location, inc.incident_date_raw, inc.incident_start_date, inc.incident_end_date,
           inc.date_reported, inc.investigation_initiated_date, inc.investigation_concluded_date,
           inc.incident_description_raw, inc.use_of_alcohol, inc.use_of_drugs, inc.outcome_raw,
           inc.hazing_determination, inc.is_aggravated, inc.verified_by, inc.verified_at
    FROM incidents inc
    JOIN chtr_reports cr ON cr.id = inc.chtr_id
    JOIN institutions i ON i.id = cr.institution_id
    LEFT JOIN raw_artifacts ra ON ra.id = cr.artifact_id
    ORDER BY inc.id
"""


def _old_db_url() -> str:
    import os
    url = os.environ.get("OLD_DATABASE_URL")
    if not url:
        raise RuntimeError("missing required environment variable: OLD_DATABASE_URL")
    return url


def _slug(name: str) -> str:
    """Identical to jobs/02-archive/run.py's `_slug` -- duplicated (not imported), same
    reasoning as migration/backfill_manifests.py's copy."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]


def _date_str(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _datetime_str(value) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_schools(schools_csv: Path) -> dict[str, dict]:
    with schools_csv.open(newline="") as f:
        return {row["unitid"]: row for row in csv.DictReader(f)}


def export_one(row: dict, schools: dict[str, dict], counts: dict) -> dict | None:
    unitid = str(row["unitid"])
    school = schools.get(unitid)
    if school is None:
        logging.warning(f"legacy incident {row['legacy_incident_id']}: unitid {unitid} not in "
                         f"current sources/schools.csv -- skipping")
        counts["skipped_unknown_institution"] += 1
        return None

    if row["content_hash"] is None:
        logging.warning(f"legacy incident {row['legacy_incident_id']}: no linked raw_artifacts "
                         f"row (artifact_id was null) -- no source document to point at, skipping")
        counts["skipped_no_document"] += 1
        return None

    inst_dir = f"{unitid}_{_slug(school['name'])}"
    scrape_year = row["scraped_at"].year
    hash16 = short_hash(row["content_hash"])
    doc_dir = f"{ARCHIVE_PREFIX}/{inst_dir}/{scrape_year}/docs/{hash16}"

    if not r2.exists(f"{doc_dir}/manifest.json"):
        logging.warning(f"legacy incident {row['legacy_incident_id']}: {doc_dir} not yet in the "
                         f"new archive -- run migration/backfill_manifests.py first, skipping")
        counts["skipped_not_backfilled"] += 1
        return None

    counts["exported"] += 1
    return {
        "legacy_incident_id": row["legacy_incident_id"],
        "unitid": unitid,
        "doc_dir": doc_dir,
        "legacy_fields": {
            "location": row["location"],
            "incident_date_raw": row["incident_date_raw"],
            "incident_start_date": _date_str(row["incident_start_date"]),
            "incident_end_date": _date_str(row["incident_end_date"]),
            "date_reported": _date_str(row["date_reported"]),
            "investigation_initiated_date": _date_str(row["investigation_initiated_date"]),
            "investigation_concluded_date": _date_str(row["investigation_concluded_date"]),
            "incident_description_raw": row["incident_description_raw"],
            "use_of_alcohol": row["use_of_alcohol"],
            "use_of_drugs": row["use_of_drugs"],
            "outcome_raw": row["outcome_raw"],
            "hazing_determination": row["hazing_determination"],
            "is_aggravated": row["is_aggravated"],
            "verified_by": row["verified_by"],
            "verified_at": _datetime_str(row["verified_at"]),
        },
    }


def run(old_db_url: str | None = None, schools_csv: Path = DEFAULT_SCHOOLS_CSV,
        out: Path = DEFAULT_OUT) -> dict:
    old_db_url = old_db_url or _old_db_url()
    schools = _read_schools(schools_csv)

    counts: dict[str, int] = {
        "exported": 0,
        "skipped_unknown_institution": 0,
        "skipped_no_document": 0,
        "skipped_not_backfilled": 0,
    }
    entries: list[dict] = []

    with psycopg.connect(old_db_url) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            cur.execute(LEGACY_INCIDENTS_QUERY)
            columns = [c.name for c in cur.description]
            for record in cur.fetchall():
                row = dict(zip(columns, record))
                entry = export_one(row, schools, counts)
                if entry is not None:
                    entries.append(entry)

    calibration_set = {"schema_version": 1, "calibration_set": entries}
    jsonschema.validate(calibration_set, CALIBRATION_SCHEMA)
    out.write_text(json.dumps(calibration_set, indent=2))

    logging.info(f"Export complete: {counts}, wrote {len(entries)} entries to {out}")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-db-url", default=None)
    parser.add_argument("--schools-csv", type=Path, default=DEFAULT_SCHOOLS_CSV)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(old_db_url=args.old_db_url, schools_csv=args.schools_csv, out=args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
