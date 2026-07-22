"""import_airtable.py -- 01-discover: cross-check confirmed CHTR URLs against the existing
schools-registry Airtable base.

The agent still discovers and confirms each institution's chtr_url on its own
(prompt.md -> candidates.json -> operator decision -> merge.py, unchanged). This script
runs *after* merge.py and only ever cross-checks -- it never writes chtr_url/url_status/
evidence, and it never edits schools.csv at all. A mismatch (or an institution Airtable has
no opinion on) is recorded, not resolved automatically; the operator decides what to do
with it.

Airtable fields used (confirmed against the live base, not the predecessor repo's field
list -- `Transparency Report` and `chtr_index_url` are kept in lockstep in this base, so
only the former is read): `UNITID`, `Transparency Report`. `State`/`City, State` are
linked-record fields in this base (not plain text), so this script does not attempt a
state backfill for `schools.csv`'s currently-blank `state` column -- that would need a
second lookup against whatever table those linked records point to, out of scope here.

Output is a derived comparison (state is derived, never stored, per CLAUDE.md) -- a re-run
just recomputes tasks/discover/airtable_cross_check.json from schools.csv's current state,
it is not an append-only archive artifact and carries no merged.json-style dedup tracking.

02-archive's write_data_check reads this same file to populate each institution's
data_check.json.airtable_cross_check field.

Run: python jobs/01-discover/import_airtable.py [--schools-csv PATH] [--tasks-dir tasks/discover/]
"""
import argparse
import csv
import json
import logging
import os
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
DEFAULT_TASKS_DIR = ROOT / "tasks" / "discover"
OUTPUT_SCHEMA = json.loads((JOB_DIR / "airtable_cross_check.schema.json").read_text())

load_dotenv(ROOT / ".env")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_airtable_urls() -> dict[str, str]:
    """{unitid: Transparency Report url} for every Airtable row that has one. Paginates
    the full table -- there is no per-unitid lookup endpoint, and the base is small enough
    (~1,500 rows) that one full pull per run is cheap."""
    token = os.environ["AIRTABLE_TOKEN"]
    base_id = os.environ["AIRTABLE_BASE_ID"]
    table_name = os.environ["AIRTABLE_TABLE_NAME"]

    urls: dict[str, str] = {}
    offset = None
    while True:
        params = {"fields[]": ["UNITID", "Transparency Report"], "pageSize": 100}
        if offset:
            params["offset"] = offset
        resp = requests.get(
            f"https://api.airtable.com/v0/{base_id}/{urllib.parse.quote(table_name)}",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        for record in data.get("records", []):
            fields = record.get("fields", {})
            unitid = fields.get("UNITID")
            url = fields.get("Transparency Report")
            if unitid and url:
                urls[str(unitid)] = url.strip()
        offset = data.get("offset")
        if not offset:
            break
    return urls


def cross_check(schools_csv: Path, airtable_urls: dict[str, str]) -> dict[str, dict]:
    """{unitid: {matched, airtable_url}} for every institution with url_status=confirmed
    in schools.csv -- institutions not yet confirmed have nothing to cross-check yet."""
    with schools_csv.open(newline="") as f:
        rows = list(csv.DictReader(f))

    results: dict[str, dict] = {}
    for row in rows:
        if (row.get("url_status") or "").strip() != "confirmed":
            continue
        unitid = row["unitid"]
        chtr_url = (row.get("chtr_url") or "").strip()
        airtable_url = airtable_urls.get(unitid)
        matched = airtable_url is not None and airtable_url.strip() == chtr_url
        results[unitid] = {"matched": matched, "airtable_url": airtable_url}
    return results


def run(schools_csv: Path = DEFAULT_SCHOOLS_CSV, tasks_dir: Path = DEFAULT_TASKS_DIR) -> dict:
    if not schools_csv.is_file():
        logging.warning(f"{schools_csv} not found -- nothing to cross-check yet")
        return {"checked": 0, "mismatches": 0}

    airtable_urls = fetch_airtable_urls()
    results = cross_check(schools_csv, airtable_urls)

    doc = {
        "schema_version": 1,
        "checked_at": _now_iso(),
        "results": results,
    }
    Draft202012Validator(OUTPUT_SCHEMA).validate(doc)

    tasks_dir.mkdir(parents=True, exist_ok=True)
    (tasks_dir / "airtable_cross_check.json").write_text(json.dumps(doc, indent=2))

    mismatches = sum(
        1 for r in results.values() if r["airtable_url"] is not None and not r["matched"]
    )
    logging.info(f"Airtable cross-check: {len(results)} confirmed institutions checked, "
                 f"{mismatches} mismatch(es)")
    return {"checked": len(results), "mismatches": mismatches}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schools-csv", type=Path, default=DEFAULT_SCHOOLS_CSV)
    parser.add_argument("--tasks-dir", type=Path, default=DEFAULT_TASKS_DIR)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(schools_csv=args.schools_csv, tasks_dir=args.tasks_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
