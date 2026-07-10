"""merge.py -- 01-discover: merge operator-confirmed CHTR URLs into sources/schools.csv.

Per IMPLEMENTATION_PLAN.md Section 7 (01-discover) and invariant 6 (human decisions are
artifacts). Reads, for each batch under tasks/discover/{batch}/, the agent's
candidates.json and the operator's decisions.json (written by the console, never by
chat), and merges confirmed URLs into sources/schools.csv. Never edits schools.csv from
anywhere else -- this script is the only write path invariant 3 permits.

Validates before merging:
  (a) candidates.json against jobs/01-discover/schema.json;
  (b) decisions.json against jobs/01-discover/decisions.schema.json;
  (c) every decision's unitid exists in schools.csv, and its proposed_url matches the
      corresponding candidate's proposed_url exactly (an operator confirms *this*
      candidate, not an arbitrary URL);
  (d) proposed_url is well-formed (http/https scheme + non-empty netloc);
  (e) no row deletion -- schools.csv's row count and unitid set are unchanged after the
      merge, only chtr_url/url_status/evidence are updated in place.

A batch is only merged once **every** candidate in its candidates.json has a matching
decision -- a partial decisions.json (operator still working through the batch) is left
untouched until the next merge.py run. A successfully merged batch is marked with
merged.json so a later batch that recycles the same unitid (a rejected school gets
rebatched) never causes this batch's stale decisions to be reapplied.

Confirmed -> chtr_url, url_status="confirmed", evidence=candidate's evidence_quote.
Rejected  -> chtr_url/evidence cleared, url_status="" (blank) so make_batches.py picks
             the school up again on the next batching pass.

Run: python jobs/01-discover/merge.py [--schools-csv PATH] [--tasks-dir tasks/discover/]
"""
import argparse
import csv
import json
import logging
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from jsonschema import Draft202012Validator  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
DEFAULT_TASKS_DIR = ROOT / "tasks" / "discover"
FIELDNAMES = ["unitid", "name", "state", "chtr_url", "url_status", "evidence"]

CANDIDATES_SCHEMA = json.loads((JOB_DIR / "schema.json").read_text())
DECISIONS_SCHEMA = json.loads((JOB_DIR / "decisions.schema.json").read_text())


class MergeError(ValueError):
    """A batch failed validation; it is left unmerged for a human to fix."""


def _is_well_formed_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _load_batch(batch_dir: Path) -> tuple[dict, dict] | None:
    """(candidates_json, decisions_json), or None if the batch isn't ready yet
    (missing candidates.json/decisions.json, already merged, or decisions.json
    doesn't yet cover every candidate -- the operator is still working through the
    batch, which is not an error)."""
    if (batch_dir / "merged.json").is_file():
        return None
    candidates_path = batch_dir / "candidates.json"
    decisions_path = batch_dir / "decisions.json"
    if not candidates_path.is_file() or not decisions_path.is_file():
        return None

    candidates_json = json.loads(candidates_path.read_text())
    decisions_json = json.loads(decisions_path.read_text())
    Draft202012Validator(CANDIDATES_SCHEMA).validate(candidates_json)
    Draft202012Validator(DECISIONS_SCHEMA).validate(decisions_json)

    candidate_unitids = {c["unitid"] for c in candidates_json["candidates"]}
    decided_unitids = {d["unitid"] for d in decisions_json["decisions"]}
    if candidate_unitids - decided_unitids:
        return None

    return candidates_json, decisions_json


def _validate_decisions(candidates_json: dict, decisions_json: dict, known_unitids: set[str]) -> None:
    candidates_by_unitid = {c["unitid"]: c for c in candidates_json["candidates"]}

    for decision in decisions_json["decisions"]:
        unitid = decision["unitid"]
        if unitid not in known_unitids:
            raise MergeError(f"unitid {unitid!r} not found in schools.csv")
        candidate = candidates_by_unitid.get(unitid)
        if candidate is None:
            raise MergeError(f"decision for unitid {unitid!r} has no matching candidate")
        if decision["proposed_url"] != candidate["proposed_url"]:
            raise MergeError(
                f"unitid {unitid!r}: decision's proposed_url does not match the candidate's"
            )
        if not _is_well_formed_url(decision["proposed_url"]):
            raise MergeError(f"unitid {unitid!r}: proposed_url is not well-formed: {decision['proposed_url']!r}")


def _apply_decisions(rows_by_unitid: dict[str, dict], candidates_json: dict, decisions_json: dict) -> None:
    candidates_by_unitid = {c["unitid"]: c for c in candidates_json["candidates"]}
    for decision in decisions_json["decisions"]:
        unitid = decision["unitid"]
        row = rows_by_unitid[unitid]
        if decision["decision"] == "confirmed":
            candidate = candidates_by_unitid[unitid]
            row["chtr_url"] = candidate["proposed_url"]
            row["url_status"] = "confirmed"
            row["evidence"] = candidate["evidence_quote"]
        else:
            row["chtr_url"] = ""
            row["url_status"] = ""
            row["evidence"] = ""


def run(schools_csv: Path = DEFAULT_SCHOOLS_CSV, tasks_dir: Path = DEFAULT_TASKS_DIR) -> dict:
    results = {"batches_merged": 0, "schools_updated": 0, "skipped": 0, "failed": 0}
    if not schools_csv.is_file() or not tasks_dir.is_dir():
        return results

    with schools_csv.open(newline="") as f:
        rows = list(csv.DictReader(f))
    rows_by_unitid = {r["unitid"]: r for r in rows}
    original_unitids = set(rows_by_unitid)

    for batch_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        try:
            loaded = _load_batch(batch_dir)
        except Exception as e:
            logging.error(f"{batch_dir.name}: failed to load -- {e}")
            results["failed"] += 1
            continue
        if loaded is None:
            results["skipped"] += 1
            continue

        candidates_json, decisions_json = loaded
        try:
            _validate_decisions(candidates_json, decisions_json, original_unitids)
            _apply_decisions(rows_by_unitid, candidates_json, decisions_json)
        except MergeError as e:
            logging.error(f"{batch_dir.name}: {e}")
            results["failed"] += 1
            continue

        (batch_dir / "merged.json").write_text(
            json.dumps({"batch": decisions_json["batch"]}, indent=2)
        )
        results["batches_merged"] += 1
        results["schools_updated"] += len(decisions_json["decisions"])
        logging.info(f"  {batch_dir.name}: merged {len(decisions_json['decisions'])} decisions")

    if results["batches_merged"]:
        assert set(rows_by_unitid) == original_unitids, "merge.py must never add or remove rows"
        with schools_csv.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()
            writer.writerows(rows)

    logging.info(f"merge run complete: {results}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schools-csv", default=str(DEFAULT_SCHOOLS_CSV))
    parser.add_argument("--tasks-dir", default=str(DEFAULT_TASKS_DIR))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(schools_csv=Path(args.schools_csv), tasks_dir=Path(args.tasks_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
