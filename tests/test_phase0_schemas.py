"""Schema smoke check: every schema in schemas/ and each job's own schema.json validates
its example document(s) in fixtures/schema_examples/. Run with:
python tests/test_phase0_schemas.py
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "schemas"
JOBS = ROOT / "jobs"
EXAMPLES = ROOT / "fixtures" / "schema_examples"

# (schema path, example path)
CASES = [
    (SCHEMAS / "manifest.schema.json", EXAMPLES / "manifest.example.json"),
    (SCHEMAS / "status.schema.json", EXAMPLES / "status.example.json"),
    (SCHEMAS / "status.schema.json", EXAMPLES / "status_no_url.example.json"),
    (SCHEMAS / "extract_metadata.schema.json", EXAMPLES / "extract_metadata.example.json"),
    (SCHEMAS / "validation.schema.json", EXAMPLES / "validation.example.json"),
    (SCHEMAS / "review.schema.json", EXAMPLES / "review.example.json"),
    (SCHEMAS / "ledger_entry.schema.json", EXAMPLES / "ledger_entry.example.json"),
    (SCHEMAS / "data_check.schema.json", EXAMPLES / "data_check.example.json"),
    (SCHEMAS / "pipeline_run.schema.json", EXAMPLES / "pipeline_run.example.json"),
    (JOBS / "01-discover" / "schema.json", EXAMPLES / "candidates.example.json"),
    (JOBS / "04-extract" / "schema.json", EXAMPLES / "incidents.example.json"),
    (JOBS / "04-extract" / "schema.json", EXAMPLES / "incidents_zero.example.json"),
]


def main() -> int:
    failures = []
    for schema_path, example_path in CASES:
        schema = json.loads(schema_path.read_text())
        example = json.loads(example_path.read_text())
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        errors = sorted(validator.iter_errors(example), key=lambda e: e.path)
        rel_schema = schema_path.relative_to(ROOT)
        rel_example = example_path.relative_to(ROOT)
        if errors:
            failures.append((rel_schema, rel_example, errors))
            print(f"FAIL  {rel_example}  against  {rel_schema}")
            for e in errors:
                print(f"      {'/'.join(str(p) for p in e.path)}: {e.message}")
        else:
            print(f"ok    {rel_example}  against  {rel_schema}")

    print()
    if failures:
        print(f"{len(failures)}/{len(CASES)} cases FAILED")
        return 1
    print(f"all {len(CASES)} cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
