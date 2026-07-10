"""make_batches.py -- 01-discover: batch sources/schools.csv into task packets of
~25-50 schools each for the agent to search.

Per IMPLEMENTATION_PLAN.md Section 7 (01-discover) and Section 16's smoke check.
Mirrors 04-extract/make_packets.py's packet-directory convention: each batch lives at
tasks/discover/{batch}/ and contains prompt.md, schema.json, and this batch's slice of
schools.csv (schools_slice.csv).

Resumable: a school already confirmed (url_status == "confirmed") or with no CHTR URL
on record (url_status == "no_url") is never re-batched. A school already in a pending
batch (url_status == "pending") is also skipped -- schools.csv's own url_status column
is the only state this script consults, so a school is eligible again the moment its
status reverts to blank (a rejected candidate, or a school never searched at all).
Batch numbering continues from the highest existing tasks/discover/batch_NNN directory,
so a crash or an interrupted session never reuses or collides with a prior batch.

Run: python jobs/01-discover/make_batches.py [--batch-size 40] [--schools-csv PATH]
     [--tasks-dir tasks/discover/]
"""
import argparse
import csv
import logging
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
DEFAULT_TASKS_DIR = ROOT / "tasks" / "discover"
DEFAULT_BATCH_SIZE = 40
FIELDNAMES = ["unitid", "name", "state", "chtr_url", "url_status", "evidence"]

BATCH_DIR_RE = re.compile(r"^batch_(\d+)$")


def read_schools(schools_csv: Path) -> list[dict]:
    with schools_csv.open(newline="") as f:
        return list(csv.DictReader(f))


def write_schools(schools_csv: Path, rows: list[dict]) -> None:
    with schools_csv.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def next_batch_number(tasks_dir: Path) -> int:
    if not tasks_dir.is_dir():
        return 1
    existing = [
        int(m.group(1))
        for p in tasks_dir.iterdir()
        if p.is_dir() and (m := BATCH_DIR_RE.match(p.name))
    ]
    return max(existing, default=0) + 1


def write_batch(batch_dir: Path, batch_name: str, rows: list[dict]) -> None:
    batch_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(JOB_DIR / "prompt.md", batch_dir / "prompt.md")
    shutil.copy(JOB_DIR / "schema.json", batch_dir / "schema.json")
    with (batch_dir / "schools_slice.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    logging.info(f"  {batch_name}: wrote {len(rows)} schools -> {batch_dir}")


def run(
    schools_csv: Path = DEFAULT_SCHOOLS_CSV,
    tasks_dir: Path = DEFAULT_TASKS_DIR,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> dict:
    if not schools_csv.is_file():
        logging.warning(f"01-discover: {schools_csv} does not exist yet -- nothing to batch")
        return {"batches_created": 0, "schools_batched": 0}

    rows = read_schools(schools_csv)
    eligible = [r for r in rows if not r.get("url_status")]

    batch_number = next_batch_number(tasks_dir)
    batches_created = 0
    schools_batched = 0

    for start in range(0, len(eligible), batch_size):
        slice_rows = eligible[start : start + batch_size]
        if not slice_rows:
            continue
        batch_name = f"batch_{batch_number:03d}"
        write_batch(tasks_dir / batch_name, batch_name, slice_rows)
        for row in slice_rows:
            row["url_status"] = "pending"
        batch_number += 1
        batches_created += 1
        schools_batched += len(slice_rows)

    if schools_batched:
        write_schools(schools_csv, rows)

    results = {"batches_created": batches_created, "schools_batched": schools_batched}
    logging.info(f"make_batches run complete: {results}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schools-csv", default=str(DEFAULT_SCHOOLS_CSV))
    parser.add_argument("--tasks-dir", default=str(DEFAULT_TASKS_DIR))
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(
        schools_csv=Path(args.schools_csv),
        tasks_dir=Path(args.tasks_dir),
        batch_size=args.batch_size,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
