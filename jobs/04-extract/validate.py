"""
validate.py -- 04-extract: validate and archive incidents.json packets (v3.0).

Per IMPLEMENTATION_PLAN.md Section 7 (validation) and Section 9 (review model). Walks
every packet under tasks/extract/ the agent has finished (incidents.json written, and
metadata.json's `model`/`created` filled in), and for each:

  (a) strict JSON-schema validation of incidents.json against schema.json (unknown
      fields rejected, per Section 8's excluded-fields list) -- invalid output is
      archived too, never silently discarded;
  (b) archives incidents.json + metadata.json + validation.json under
      {doc_dir}/ai/extract_v{N}/, where doc_dir and N come from the packet's
      metadata.json stub (written by make_packets.py), not re-derived here.

v3.0 drops anchoring and tier assignment entirely (IMPLEMENTATION_PLAN.md Section 9):
validation.json is now just {schema_version, valid, schema_errors}. Per-incident
extraction_confidence and flags[] are carried in incidents.json itself (schema.json),
not computed here -- the AI reports them, this script only checks conformance.
Organization matching and cross-year incident-status resolution are also not this job's
concern: they're derived by 06-publish/rebuild.py at publish time (invariant 7 -- state
is derived, never stored), not something 04-extract needs to compute or store.

Idempotent/resumable: a packet whose target {doc_dir}/ai/extract_v{N}/incidents.json
already exists in the archive is skipped.

Run: python jobs/04-extract/validate.py [--tasks-dir tasks/extract/]
"""
import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from jsonschema import Draft202012Validator  # noqa: E402

from lib import r2  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_TASKS_DIR = ROOT / "tasks" / "extract"

INCIDENTS_SCHEMA = json.loads((JOB_DIR / "schema.json").read_text())
EXTRACT_METADATA_SCHEMA = json.loads((ROOT / "schemas" / "extract_metadata.schema.json").read_text())
VALIDATION_SCHEMA = json.loads((ROOT / "schemas" / "validation.schema.json").read_text())


def _load_packet(packet_dir: Path) -> tuple[str, dict] | None:
    """(incidents.json raw text, metadata dict) once the agent has finished the
    packet, else None -- a missing incidents.json/metadata.json, or a metadata.json
    still missing `model`/`created`, means the agent hasn't finished yet."""
    incidents_path = packet_dir / "incidents.json"
    metadata_path = packet_dir / "metadata.json"
    if not incidents_path.is_file() or not metadata_path.is_file():
        return None
    metadata = json.loads(metadata_path.read_text())
    if metadata.get("model") is None or metadata.get("created") is None:
        return None
    return incidents_path.read_text(), metadata


def _schema_errors(incidents_json) -> list[str]:
    validator = Draft202012Validator(INCIDENTS_SCHEMA)
    errors = sorted(validator.iter_errors(incidents_json), key=lambda e: [str(p) for p in e.path])
    return [f"{'/'.join(str(p) for p in err.path) or '<root>'}: {err.message}" for err in errors]


def validate(incidents_json) -> dict:
    if not isinstance(incidents_json, dict):
        return {
            "schema_version": 2,
            "valid": False,
            "schema_errors": ["top-level value must be an object"],
        }
    schema_errors = _schema_errors(incidents_json)
    return {
        "schema_version": 2,
        "valid": not schema_errors,
        "schema_errors": schema_errors,
    }


def archive_packet(packet_dir: Path) -> str:
    """Returns "pending" (agent not done), "skipped" (already archived), or
    "archived"."""
    loaded = _load_packet(packet_dir)
    if loaded is None:
        return "pending"
    incidents_text, metadata = loaded

    doc_dir = metadata["doc_dir"]
    target_version = metadata["target_version"]
    version_prefix = f"{doc_dir}/ai/extract_v{target_version}"
    if r2.exists(f"{version_prefix}/incidents.json"):
        return "skipped"

    try:
        incidents_json = json.loads(incidents_text)
        parse_error = None
    except json.JSONDecodeError as e:
        incidents_json, parse_error = None, str(e)

    if parse_error is not None:
        validation = {
            "schema_version": 2,
            "valid": False,
            "schema_errors": [f"invalid JSON: {parse_error}"],
        }
    else:
        validation = validate(incidents_json)

    final_metadata = {k: metadata[k] for k in ("schema_version", "model", "prompt_version", "created")}
    Draft202012Validator(EXTRACT_METADATA_SCHEMA).validate(final_metadata)
    Draft202012Validator(VALIDATION_SCHEMA).validate(validation)

    r2.put_bytes(f"{version_prefix}/incidents.json", incidents_text.encode("utf-8"))
    r2.put_bytes(f"{version_prefix}/metadata.json", json.dumps(final_metadata, indent=2).encode("utf-8"))
    r2.put_bytes(f"{version_prefix}/validation.json", json.dumps(validation, indent=2).encode("utf-8"))
    return "archived"


def run(tasks_dir: Path = DEFAULT_TASKS_DIR) -> dict:
    results = {"archived": 0, "skipped": 0, "pending": 0, "failed": 0}
    if not tasks_dir.is_dir():
        return results

    for packet_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        try:
            outcome = archive_packet(packet_dir)
        except Exception as e:
            logging.error(f"{packet_dir.name}: validate/archive failed -- {e}")
            results["failed"] += 1
            continue
        results[outcome] += 1

    logging.info(f"validate run complete: {results}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks-dir", default=str(DEFAULT_TASKS_DIR))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(tasks_dir=Path(args.tasks_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
