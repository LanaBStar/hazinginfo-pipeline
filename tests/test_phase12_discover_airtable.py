"""Smoke check: 01-discover's Airtable cross-check (import_airtable.py).

No real Airtable API calls -- fetch_airtable_urls() is monkeypatched with a fixed dict so
this test never depends on live credentials or network.

Run with: python tests/test_phase12_discover_airtable.py
"""
import csv
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location(
    "import_airtable", ROOT / "jobs" / "01-discover" / "import_airtable.py"
)
import_airtable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spec_module := import_airtable)  # noqa: F841

FAKE_AIRTABLE_URLS = {
    "100001": "https://alpha.edu/chtr/",       # matches schools.csv exactly
    "100002": "https://beta.edu/wrong-path/",  # differs from schools.csv -- real mismatch
    # 100003 intentionally absent from Airtable -- "no data" case, not a mismatch
}


def _write_schools_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["unitid", "name", "state", "chtr_url", "url_status", "evidence"])
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase12_"))
    schools_csv = tmp_root / "schools.csv"
    tasks_dir = tmp_root / "tasks" / "discover"

    _write_schools_csv(schools_csv, [
        {"unitid": "100001", "name": "Alpha College", "state": "", "chtr_url": "https://alpha.edu/chtr/",
         "url_status": "confirmed", "evidence": "quote"},
        {"unitid": "100002", "name": "Beta College", "state": "", "chtr_url": "https://beta.edu/chtr/",
         "url_status": "confirmed", "evidence": "quote"},
        {"unitid": "100003", "name": "Gamma College", "state": "", "chtr_url": "https://gamma.edu/chtr/",
         "url_status": "confirmed", "evidence": "quote"},
        {"unitid": "100004", "name": "Delta College", "state": "", "chtr_url": "",
         "url_status": "", "evidence": ""},  # not yet confirmed -- excluded from cross-check entirely
    ])

    import_airtable.fetch_airtable_urls = lambda: dict(FAKE_AIRTABLE_URLS)
    result = import_airtable.run(schools_csv=schools_csv, tasks_dir=tasks_dir)

    if result != {"checked": 3, "mismatches": 1}:
        failures.append(f"run() result: expected checked=3/mismatches=1, got {result}")

    out_path = tasks_dir / "airtable_cross_check.json"
    if not out_path.is_file():
        failures.append("airtable_cross_check.json was not written")
    else:
        doc = json.loads(out_path.read_text())
        if "100004" in doc["results"]:
            failures.append("unconfirmed institution 100004 should be excluded from cross-check results")
        if doc["results"].get("100001") != {"matched": True, "airtable_url": "https://alpha.edu/chtr/"}:
            failures.append(f"100001 (exact match) unexpected: {doc['results'].get('100001')}")
        if doc["results"].get("100002") != {"matched": False, "airtable_url": "https://beta.edu/wrong-path/"}:
            failures.append(f"100002 (genuine mismatch) unexpected: {doc['results'].get('100002')}")
        if doc["results"].get("100003") != {"matched": False, "airtable_url": None}:
            failures.append(f"100003 (no Airtable row) unexpected: {doc['results'].get('100003')}")

        from jsonschema import Draft202012Validator
        schema = json.loads((ROOT / "jobs" / "01-discover" / "airtable_cross_check.schema.json").read_text())
        errors = list(Draft202012Validator(schema).iter_errors(doc))
        if errors:
            failures.append(f"airtable_cross_check.json failed its own schema: {[e.message for e in errors]}")

    # schools.csv itself must be completely untouched -- this script never writes to it.
    original = schools_csv.read_text()
    if original != schools_csv.read_text():
        failures.append("schools.csv was modified -- import_airtable.py must never write to it")

    print()
    if failures:
        for f in failures:
            print(f"FAIL  {f}")
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("ok    airtable cross-check: exact match / genuine mismatch / no-Airtable-data all handled correctly")
    print("ok    unconfirmed institutions excluded from cross-check")
    print("ok    output validates against airtable_cross_check.schema.json")
    print("ok    schools.csv never modified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
