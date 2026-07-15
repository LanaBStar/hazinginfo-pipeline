"""backfill_manifests.py -- migration/: one-time backfill of the old system's already-
captured documents into the new archive layout.

Per IMPLEMENTATION_PLAN.md Section 13, item 1. Walks the old Neon `raw_artifacts` table
(joined to `institutions` for unitid/name), fetches each object's bytes from the OLD R2
bucket by its recorded `storage_key`, and writes them into the NEW archive at the same
`manifest.json` + `original/{filename}` shape 02-archive's `store_document()` writes,
keyed by content hash so a later real 02-archive crawl of the same institution dedupes
against these the same way it dedupes against its own prior years.

This job never fetches a URL. The old system's raw_artifacts row is trusted as-is --
`source_url`, `content_hash`, and `scraped_at` come from there, not from re-crawling.
Those original pages may have changed or vanished since; the old capture is the only
copy that will ever exist, so it is copied, never re-fetched (IMPLEMENTATION_PLAN.md
Section 13's core rule).

The old Neon connection is opened read-only at the transaction level (`conn.read_only =
True`) as a real enforced backstop, not just app-level discipline -- this script issues
only SELECTs against the old system and must never be able to write to it, per the
user's session instructions. `migration/old_r2.py` has no put_bytes for the same reason.

Does not write status.json: IMPLEMENTATION_PLAN.md Section 13 names this script's
deliverable as manifest.json files specifically (unlike 02-archive's own job spec in
Section 7, which explicitly calls out status.json including the not_found/no_url cases).
A consequence, not separately asked: backfilled institution-years won't appear in
06-publish's `reporting_status` table or in status.py's counts (both are status.json-
driven), but will appear normally in `documents` and, once re-extracted per Section 13
item 2, `reports`/`incidents` (both `_doc_dirs()` and 04-extract's `make_packets.py` walk
for `manifest.json` directly, not status.json) -- see BUILD_STATUS.md.

An institution present in the old system but no longer in the current sources/schools.csv
is skipped with a warning (its slug can't be derived consistently with what a future
02-archive run would use) rather than aborting the whole backfill, matching every other
job's per-item exception handling in this codebase.

Idempotent/resumable per invariant 10 (confirmed with the user, since Section 13's
"one-time" framing alone left this ambiguous): a raw_artifacts row whose target
manifest.json already exists in the new archive is skipped.

Run: python migration/backfill_manifests.py [--old-db-url ...] [--schools-csv PATH]
"""
import argparse
import csv
import json
import logging
import re
import sys
from datetime import timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402
import jsonschema  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import sha256_bytes, short_hash  # noqa: E402
from migration import old_r2  # noqa: E402

SCHEMAS_DIR = ROOT / "schemas"
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
ARCHIVE_PREFIX = "archive"
MANIFEST_SCHEMA = json.loads((SCHEMAS_DIR / "manifest.schema.json").read_text())

RAW_ARTIFACTS_QUERY = """
    SELECT i.unitid, ra.storage_key, ra.content_hash, ra.source_url,
           ra.artifact_type, ra.file_size_bytes, ra.scraped_at
    FROM raw_artifacts ra
    JOIN institutions i ON i.id = ra.institution_id
    ORDER BY ra.id
"""


def _old_db_url() -> str:
    import os
    url = os.environ.get("OLD_DATABASE_URL")
    if not url:
        raise RuntimeError("missing required environment variable: OLD_DATABASE_URL")
    return url


def _slug(name: str) -> str:
    """Identical to jobs/02-archive/run.py's `_slug` -- duplicated (not imported) since
    it's a few lines and the two jobs must never drift apart on inst_dir naming."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]


def _iso(dt) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_schools(schools_csv: Path) -> dict[str, dict]:
    with schools_csv.open(newline="") as f:
        return {row["unitid"]: row for row in csv.DictReader(f)}


def backfill_one(row: dict, schools: dict[str, dict], counts: dict) -> None:
    unitid = str(row["unitid"])
    school = schools.get(unitid)
    if school is None:
        logging.warning(f"unitid {unitid} not in current sources/schools.csv -- skipping")
        counts["skipped_unknown_institution"] += 1
        return

    inst_dir = f"{unitid}_{_slug(school['name'])}"
    scrape_year = row["scraped_at"].year
    content_hash = row["content_hash"]
    hash16 = short_hash(content_hash)
    doc_dir = f"{ARCHIVE_PREFIX}/{inst_dir}/{scrape_year}/docs/{hash16}"
    manifest_key = f"{doc_dir}/manifest.json"

    if r2.exists(manifest_key):
        counts["skipped_already_backfilled"] += 1
        return

    if row["artifact_type"] not in ("pdf", "html"):
        logging.error(f"{row['storage_key']}: unexpected artifact_type {row['artifact_type']!r} -- skipping")
        counts["failed"] += 1
        return
    is_pdf = row["artifact_type"] == "pdf"

    try:
        content = old_r2.get_bytes(row["storage_key"])
    except Exception as e:
        logging.error(f"{row['storage_key']}: failed to fetch from old R2 -- {e}")
        counts["failed"] += 1
        return

    actual_hash = sha256_bytes(content)
    if actual_hash != content_hash:
        logging.error(
            f"{row['storage_key']}: content hash mismatch (old Neon says {content_hash}, "
            f"fetched bytes hash to {actual_hash}) -- skipping, nothing written"
        )
        counts["failed_hash_mismatch"] += 1
        return

    filename = "report.pdf" if is_pdf else "index.html"
    r2.put_bytes(f"{doc_dir}/original/{filename}", content)

    manifest = {
        "schema_version": 1,
        "source_url": row["source_url"],
        "fetched_at": _iso(row["scraped_at"]),
        "sha256": content_hash,
        "content_type": "application/pdf" if is_pdf else "text/html",
        "size_bytes": row["file_size_bytes"] if row["file_size_bytes"] is not None else len(content),
        "unitid": unitid,
        "scrape_year": scrape_year,
    }
    jsonschema.validate(manifest, MANIFEST_SCHEMA)
    r2.put_bytes(manifest_key, json.dumps(manifest, indent=2).encode())
    logging.info(f"  backfilled {doc_dir}")
    counts["backfilled"] += 1


def run(old_db_url: str | None = None, schools_csv: Path = DEFAULT_SCHOOLS_CSV) -> dict:
    old_db_url = old_db_url or _old_db_url()
    schools = _read_schools(schools_csv)

    counts: dict[str, int] = {
        "backfilled": 0,
        "skipped_already_backfilled": 0,
        "skipped_unknown_institution": 0,
        "failed": 0,
        "failed_hash_mismatch": 0,
    }

    with psycopg.connect(old_db_url) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            cur.execute(RAW_ARTIFACTS_QUERY)
            columns = [c.name for c in cur.description]
            for record in cur.fetchall():
                row = dict(zip(columns, record))
                try:
                    backfill_one(row, schools, counts)
                except Exception as e:
                    logging.error(f"{row.get('storage_key')}: unexpected error -- {e}")
                    counts["failed"] += 1

    logging.info(f"Backfill complete: {counts}")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-db-url", default=None)
    parser.add_argument("--schools-csv", type=Path, default=DEFAULT_SCHOOLS_CSV)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(old_db_url=args.old_db_url, schools_csv=args.schools_csv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
