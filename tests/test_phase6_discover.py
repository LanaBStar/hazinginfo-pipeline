"""Phase 6 smoke check: jobs/01-discover/make_batches.py + merge.py.

Builds a small synthetic sources/schools.csv copy (5 schools, matching the pattern
every prior phase's smoke check uses -- a throwaway CSV, never the real 1,484-row
sources/schools.csv) and exercises the full candidate -> confirm -> merge round trip
per IMPLEMENTATION_PLAN.md Section 16:

  1. make_batches.py slices the 5 eligible (blank url_status) schools into batches of
     3, marking batched rows "pending"; a second run batches nothing new.
  2. A candidates.json is hand-written for batch_001 (standing in for the agent) and a
     matching decisions.json for batch_001 confirming two schools and rejecting one;
     batch_002 gets a candidates.json but an incomplete decisions.json (one decision
     missing), which merge.py must leave untouched.
  3. merge.py merges batch_001 only: confirmed rows get chtr_url/url_status=confirmed/
     evidence; the rejected row reverts to blank url_status (eligible for re-batching);
     batch_002's rows are untouched (still "pending"); schools.csv's row count and
     unitid set are unchanged; batch_001 is marked merged.json, batch_002 is not.
  4. A second merge.py run is idempotent (batch_001 already merged, batch_002 still
     incomplete -- nothing changes).
  5. A second make_batches.py run re-batches the rejected school (now blank again)
     into a new batch, while confirmed/still-pending schools are never re-batched.

Run with: python tests/test_phase6_discover.py
"""
import csv
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FIELDNAMES = ["unitid", "name", "state", "chtr_url", "url_status", "evidence"]


def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


make_batches = _load_module("make_batches", "jobs/01-discover/make_batches.py")
merge = _load_module("merge", "jobs/01-discover/merge.py")

SCHOOLS = [
    {"unitid": "100001", "name": "Alpha College", "state": "", "chtr_url": "", "url_status": "", "evidence": ""},
    {"unitid": "100002", "name": "Beta University", "state": "", "chtr_url": "", "url_status": "", "evidence": ""},
    {"unitid": "100003", "name": "Gamma Institute", "state": "", "chtr_url": "", "url_status": "", "evidence": ""},
    {"unitid": "100004", "name": "Delta Tech", "state": "", "chtr_url": "", "url_status": "", "evidence": ""},
    {"unitid": "100005", "name": "Epsilon State", "state": "", "chtr_url": "", "url_status": "", "evidence": ""},
]


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(rows)


def read_csv(path: Path) -> dict[str, dict]:
    with path.open(newline="") as f:
        return {r["unitid"]: r for r in csv.DictReader(f)}


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="phase6_discover_"))
    try:
        schools_csv = tmp / "schools.csv"
        tasks_dir = tmp / "tasks_discover"
        write_csv(schools_csv, SCHOOLS)

        # 1. First batching pass: batch size 3 over 5 eligible schools -> 2 batches.
        result = make_batches.run(schools_csv=schools_csv, tasks_dir=tasks_dir, batch_size=3)
        assert result == {"batches_created": 2, "schools_batched": 5}, result
        batch_001, batch_002 = tasks_dir / "batch_001", tasks_dir / "batch_002"
        assert batch_001.is_dir() and batch_002.is_dir()
        assert (batch_001 / "prompt.md").is_file()
        assert (batch_001 / "schema.json").is_file()
        b1_rows = list(csv.DictReader((batch_001 / "schools_slice.csv").open()))
        b2_rows = list(csv.DictReader((batch_002 / "schools_slice.csv").open()))
        assert len(b1_rows) == 3 and len(b2_rows) == 2
        rows_after_batch1 = read_csv(schools_csv)
        assert all(r["url_status"] == "pending" for r in rows_after_batch1.values())

        # Second batching pass: nothing eligible (everything is "pending") -> no-op.
        result = make_batches.run(schools_csv=schools_csv, tasks_dir=tasks_dir, batch_size=3)
        assert result == {"batches_created": 0, "schools_batched": 0}, result
        assert not (tasks_dir / "batch_003").exists()

        # 2. Hand-write candidates.json + decisions.json (standing in for the agent
        # and the operator) for batch_001: confirm 2, reject 1.
        b1_unitids = [r["unitid"] for r in b1_rows]
        candidates_1 = {
            "schema_version": 1,
            "batch": "batch_001",
            "candidates": [
                {
                    "unitid": b1_unitids[0],
                    "proposed_url": "https://example.edu/chtr-2025",
                    "confidence": 0.92,
                    "evidence_quote": "Campus Hazing Transparency Report — 2025",
                },
                {
                    "unitid": b1_unitids[1],
                    "proposed_url": "https://example.edu/hazing-report",
                    "confidence": 0.81,
                    "evidence_quote": "Hazing Transparency Report",
                },
                {
                    "unitid": b1_unitids[2],
                    "proposed_url": "https://example.edu/maybe-chtr",
                    "confidence": 0.4,
                    "evidence_quote": "Compliance filings",
                },
            ],
        }
        (batch_001 / "candidates.json").write_text(json.dumps(candidates_1))
        decisions_1 = {
            "schema_version": 1,
            "batch": "batch_001",
            "decisions": [
                {"unitid": b1_unitids[0], "decision": "confirmed", "proposed_url": "https://example.edu/chtr-2025"},
                {"unitid": b1_unitids[1], "decision": "confirmed", "proposed_url": "https://example.edu/hazing-report"},
                {"unitid": b1_unitids[2], "decision": "rejected", "proposed_url": "https://example.edu/maybe-chtr"},
            ],
        }
        (batch_001 / "decisions.json").write_text(json.dumps(decisions_1))

        # batch_002 gets a candidates.json but an *incomplete* decisions.json (one
        # candidate has no decision yet) -- merge.py must leave it untouched.
        b2_unitids = [r["unitid"] for r in b2_rows]
        candidates_2 = {
            "schema_version": 1,
            "batch": "batch_002",
            "candidates": [
                {
                    "unitid": b2_unitids[0],
                    "proposed_url": "https://example.edu/report",
                    "confidence": 0.7,
                    "evidence_quote": "Hazing Transparency Report",
                },
                {
                    "unitid": b2_unitids[1],
                    "proposed_url": "https://example.edu/report2",
                    "confidence": 0.6,
                    "evidence_quote": "Hazing Transparency Report",
                },
            ],
        }
        (batch_002 / "candidates.json").write_text(json.dumps(candidates_2))
        decisions_2_incomplete = {
            "schema_version": 1,
            "batch": "batch_002",
            "decisions": [
                {"unitid": b2_unitids[0], "decision": "confirmed", "proposed_url": "https://example.edu/report"},
            ],
        }
        (batch_002 / "decisions.json").write_text(json.dumps(decisions_2_incomplete))

        # 3. Merge.
        result = merge.run(schools_csv=schools_csv, tasks_dir=tasks_dir)
        assert result["batches_merged"] == 1, result
        assert result["schools_updated"] == 3, result
        assert result["skipped"] == 1, result  # batch_002, incomplete
        assert (batch_001 / "merged.json").is_file()
        assert not (batch_002 / "merged.json").exists()

        rows_after_merge = read_csv(schools_csv)
        assert set(rows_after_merge) == {r["unitid"] for r in SCHOOLS}, "no rows added/removed"
        assert len(rows_after_merge) == 5

        confirmed_1 = rows_after_merge[b1_unitids[0]]
        assert confirmed_1["url_status"] == "confirmed"
        assert confirmed_1["chtr_url"] == "https://example.edu/chtr-2025"
        assert confirmed_1["evidence"] == "Campus Hazing Transparency Report — 2025"

        confirmed_2 = rows_after_merge[b1_unitids[1]]
        assert confirmed_2["url_status"] == "confirmed"
        assert confirmed_2["chtr_url"] == "https://example.edu/hazing-report"

        rejected = rows_after_merge[b1_unitids[2]]
        assert rejected["url_status"] == "", rejected
        assert rejected["chtr_url"] == ""
        assert rejected["evidence"] == ""

        # batch_002's schools are untouched -- still "pending" from the batching pass.
        for unitid in b2_unitids:
            assert rows_after_merge[unitid]["url_status"] == "pending"

        # 4. Second merge.py run: idempotent -- batch_001 already merged (skipped),
        # batch_002 still incomplete (skipped). Nothing changes.
        result_2 = merge.run(schools_csv=schools_csv, tasks_dir=tasks_dir)
        assert result_2["batches_merged"] == 0, result_2
        assert result_2["skipped"] == 2, result_2
        assert read_csv(schools_csv) == rows_after_merge, "second merge run must be a no-op"

        # 5. Re-batching: the rejected school (blank again) is eligible; the
        # confirmed and still-pending schools are not.
        result_3 = make_batches.run(schools_csv=schools_csv, tasks_dir=tasks_dir, batch_size=3)
        assert result_3 == {"batches_created": 1, "schools_batched": 1}, result_3
        batch_003 = tasks_dir / "batch_003"
        assert batch_003.is_dir()
        b3_rows = list(csv.DictReader((batch_003 / "schools_slice.csv").open()))
        assert [r["unitid"] for r in b3_rows] == [b1_unitids[2]]

        print("test_phase6_discover: OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
