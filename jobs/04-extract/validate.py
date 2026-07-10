"""
validate.py -- 04-extract: validate, anchor, tier, and archive incidents.json packets.

Per IMPLEMENTATION_PLAN.md Section 7 (validation) and Section 9 (tiers). Walks every
packet under tasks/extract/ the agent has finished (incidents.json written, and
metadata.json's `model`/`created` filled in), and for each:

  (a) strict JSON-schema validation of incidents.json against schema.json (unknown
      fields rejected, per Section 8's excluded-fields list) -- invalid output is
      archived too, never silently discarded;
  (b) anchors every quote, and document.zero_incidents_quote, against the document's
      extracted/text.txt via lib/quotes.anchor_quote;
  (c) assigns a tier per Section 9 -- per incident, and (since a zero-incident report
      has no incidents to carry a tier) a document-level tier for that case;
  (d) archives incidents.json + metadata.json + validation.json under
      {doc_dir}/ai/extract_v{N}/, where doc_dir and N come from the packet's
      metadata.json stub (written by make_packets.py), not re-derived here.

The cross-check second pass (04-extract/crosscheck_prompt.md) has no packet-creation
or output-file convention yet -- this phase always writes crosscheck: null, so per
Section 9's table no incident can reach "standard" (that requires cross-check
agreement) until a later phase wires up a second-pass packet flow. Only "fast"
(zero-incident reports) and "flagged" are reachable from this job today.

Idempotent/resumable: a packet whose target {doc_dir}/ai/extract_v{N}/incidents.json
already exists in the archive is skipped.

Run: python jobs/04-extract/validate.py [--tasks-dir tasks/extract/]
"""
import argparse
import json
import logging
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from jsonschema import Draft202012Validator  # noqa: E402

from lib import r2  # noqa: E402
from lib.quotes import anchor_quote  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_TASKS_DIR = ROOT / "tasks" / "extract"

INCIDENTS_SCHEMA = json.loads((JOB_DIR / "schema.json").read_text())
EXTRACT_METADATA_SCHEMA = json.loads((ROOT / "schemas" / "extract_metadata.schema.json").read_text())
VALIDATION_SCHEMA = json.loads((ROOT / "schemas" / "validation.schema.json").read_text())

# Section 9's flagged condition is "sanction quote containing suspension/expulsion" --
# matched by stem so it catches the inflections real reports actually use
# ("suspended", "suspension", "expelled", "expulsion").
SUSPENSION_EXPULSION_RE = re.compile(r"suspen|expel|expuls", re.IGNORECASE)


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


def _anchor(quote: dict | None, document_text: str) -> dict | None:
    if quote is None:
        return None
    return anchor_quote(quote["text"], quote["page"], document_text)


def _anchor_ok(result: dict | None) -> bool:
    return result is None or result["anchored"]


def _document_result(incidents_json: dict, document_text: str) -> dict:
    document = incidents_json.get("document") or {}
    is_chtr = incidents_json.get("is_chtr")
    incidents = incidents_json.get("incidents") or []
    zero_quote = document.get("zero_incidents_quote")
    zero_anchor = _anchor(zero_quote, document_text)

    tier, flagged_reasons = None, []
    if is_chtr and not incidents:
        if zero_quote is None:
            tier, flagged_reasons = "flagged", ["missing_zero_incidents_quote"]
        elif not document_text.strip():
            tier, flagged_reasons = "flagged", ["empty_text_layer", "anchoring_failed:zero_incidents_quote"]
        elif zero_anchor["anchored"]:
            tier, flagged_reasons = "fast", []
        else:
            tier, flagged_reasons = "flagged", ["anchoring_failed:zero_incidents_quote"]

    return {"zero_incidents_quote": zero_anchor, "tier": tier, "flagged_reasons": flagged_reasons}


def _incident_result(index: int, incident: dict, document_text: str) -> dict:
    organization_quote = incident.get("organization_quote")
    sanction_quotes = incident.get("sanction_quotes") or []
    incident_quote = (incident.get("dates") or {}).get("incident_quote")

    quotes = {
        "organization_quote": _anchor(organization_quote, document_text),
        "description_quote": _anchor(incident.get("description_quote"), document_text),
        "findings_quote": _anchor(incident.get("findings_quote"), document_text),
        "sanction_quotes": [_anchor(q, document_text) for q in sanction_quotes],
        "incident_quote": _anchor(incident_quote, document_text),
    }

    flagged_reasons = []
    if not document_text.strip():
        flagged_reasons.append("empty_text_layer")
    for name in ("organization_quote", "description_quote", "findings_quote", "incident_quote"):
        if not _anchor_ok(quotes[name]):
            flagged_reasons.append(f"anchoring_failed:{name}")
    for i, result in enumerate(quotes["sanction_quotes"]):
        if not _anchor_ok(result):
            flagged_reasons.append(f"anchoring_failed:sanction_quotes[{i}]")
    if organization_quote is None:
        flagged_reasons.append("missing_organization_quote")
    if any(SUSPENSION_EXPULSION_RE.search(q["text"]) for q in sanction_quotes):
        flagged_reasons.append("sanction_contains_suspension_or_expulsion")

    # crosscheck is always null this phase (see module docstring); its condition for
    # "standard" therefore can never be satisfied yet, so every incident lands flagged.
    crosscheck = None
    if flagged_reasons or not (crosscheck and crosscheck.get("agrees") is True):
        tier = "flagged"
    else:
        tier = "standard"

    return {
        "index": index,
        "tier": tier,
        "flagged_reasons": flagged_reasons,
        "quotes": quotes,
        "crosscheck": crosscheck,
    }


def validate_and_tier(incidents_json, document_text: str) -> dict:
    schema_errors = _schema_errors(incidents_json)
    valid = not schema_errors

    if not isinstance(incidents_json, dict):
        return {
            "schema_version": 1,
            "valid": False,
            "schema_errors": schema_errors or ["top-level value must be an object"],
            "document": {"zero_incidents_quote": None, "tier": None, "flagged_reasons": []},
            "incidents": [],
        }

    document_result = _document_result(incidents_json, document_text)
    incident_results = [
        _incident_result(i, incident, document_text)
        for i, incident in enumerate(incidents_json.get("incidents") or [])
    ]

    return {
        "schema_version": 1,
        "valid": valid,
        "schema_errors": schema_errors,
        "document": document_result,
        "incidents": incident_results,
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

    document_text = r2.get_bytes(f"{doc_dir}/extracted/text.txt").decode("utf-8", errors="replace")

    if parse_error is not None:
        validation = {
            "schema_version": 1,
            "valid": False,
            "schema_errors": [f"invalid JSON: {parse_error}"],
            "document": {"zero_incidents_quote": None, "tier": None, "flagged_reasons": []},
            "incidents": [],
        }
    else:
        validation = validate_and_tier(incidents_json, document_text)

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
