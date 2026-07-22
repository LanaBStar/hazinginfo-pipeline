"""
ingest.py -- 05-review: validate and archive one review.json (the review Worker's
write path).

This module is the settled validation/write logic; jobs/05-review/app/worker/src/
ingest.ts is a line-for-line TypeScript port of it, since a Cloudflare Worker can't run
Python. Both are tested against the same fixture archive shape and must reject/accept
identically -- treat this file, not the port, as the source of truth when the two ever
appear to disagree.

There are no tiers, escalation, second_review, or quote-anchoring on correction --
there's nothing left to anchor against once quotes themselves are gone. `decision` is a
single, final call: approved/rejected/corrected. `corrections` is a list, one entry per
changed field (matching Staging_incident_corrections' one-row-per-field grain);
`organization_review` is an independent decision on the incident's proposed
organization.

`ingest_review(doc_dir, review_json)` does the following, in order, and never partially
writes:
  1. Validates `review_json` against schemas/review.schema.json (unknown fields
     rejected, since that schema is `additionalProperties: false`).
  2. Confirms `extraction_ref.file_hash` really is the sha256 of some
     `ai/extract_v{N}/incidents.json` under `doc_dir` -- pinning the decision to
     that exact extraction: a later re-extraction writes a *new* version file, so
     an old review's file_hash still resolves to the exact bytes it reviewed, never
     silently reassigned to the new one. Searches every version under `doc_dir`,
     not just the current one, since the review may have been submitted against an
     older extraction than whatever is "current" now.
  3. Confirms `extraction_ref.incident_index` is in range for that extraction's
     `incidents[]` -- or, if null, that the extraction really is a zero-incident
     report with no incidents[] to index (null means "the whole document").
  4. If `decision == "corrected"`: confirms `incident_index` is not null (a
     document-level review can never be "corrected" -- there is no per-field
     correction vocabulary for the document object; reject it instead to send it
     back for re-extraction) and every correction's `field_name` is one of the
     known correctable incident fields (CORRECTABLE_FIELDS below -- mirrors
     jobs/06-publish/rebuild.py's own whitelist, applied here too so a malformed
     review is rejected at write time, not silently archived and only discovered at
     the next rebuild).
  5. If `organization_review` is present: confirms `incident_index` is not null (a
     zero-incident document has no organization to review).
  6. Writes the review to `{doc_dir}/reviews/{incident_index}_{reviewer-slug}_{ts}
     .review.json` -- or `{doc_dir}/reviews/document_{reviewer-slug}_{ts}
     .review.json` for a document-level (null incident_index) review. Never
     overwrites: the archive is append-only.

`doc_dir` is supplied by the caller, not read out of review.json -- review.schema.json
has no such field; the review app already knows it from the queue (`GET /api/queue`'s
`docDir`).

Reviewer identity: `ingest_review()` trusts whatever `reviewer` string it's handed --
the Worker overwrites it with the resolved Access/DEV_MODE identity before calling this,
per jobs/05-review/app/worker/src/index.ts.

reviewer-slug / ts (the filename tokens above): lowercase `reviewer`, non-alphanumeric runs
collapsed to a single `-`, leading/trailing `-` stripped; `ts` is `reviewed_at`
reformatted to a compact filename-safe UTC form (colons/punctuation stripped), e.g.
"jane@x.edu" + "2026-07-12T15:30:00Z" -> "jane-x-edu" + "20260712T153000Z".

Run standalone: python jobs/05-review/ingest.py --doc-dir <archive path> --review <path
to a review.json file>
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from jsonschema import Draft202012Validator  # noqa: E402
from jsonschema.exceptions import ValidationError as SchemaValidationError  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import sha256_bytes  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
REVIEW_SCHEMA = json.loads((ROOT / "schemas" / "review.schema.json").read_text())

# review.json's `corrections[].field_name` values a reviewer may actually correct.
# Mirrors jobs/06-publish/rebuild.py's own CORRECTION_FIELDS whitelist -- organization
# fields other than type go through here too (organization_type itself is corrected via
# `organization_review.corrected_organization_type` instead, since it has its own
# independent approve/reject decision).
CORRECTABLE_FIELDS = {
    "organization_name_raw",
    "organization_name_normalized",
    "description_raw",
    "findings_raw",
    "sanctions_raw",
    "alcohol_involved",
    "drugs_involved",
    "determination_status",
    "dates.incident_start_raw",
    "dates.incident_start_normalized",
    "dates.incident_start_precision",
    "dates.incident_end_raw",
    "dates.incident_end_normalized",
    "dates.incident_end_precision",
    "dates.investigation_start_date_raw",
    "dates.investigation_start_date",
    "dates.investigation_end_date_raw",
    "dates.investigation_end_date",
    "dates.notice_date_raw",
    "dates.notice_date",
}


class IngestError(ValueError):
    """review_json failed validation, hash-pinning, or range-checking --
    ingest_review() never writes anything when this is raised."""


def _slugify(reviewer: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", reviewer.lower()).strip("-")
    return slug or "reviewer"


def _filename_ts(reviewed_at: str) -> str:
    dt = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _find_incidents_json(doc_dir: str, file_hash: str) -> dict:
    prefix = f"{doc_dir}/ai/extract_v"
    for key in r2.list_keys(f"{doc_dir}/ai/"):
        if not key.startswith(prefix) or not key.endswith("/incidents.json"):
            continue
        raw = r2.get_bytes(key)
        if sha256_bytes(raw) == file_hash:
            return json.loads(raw)
    raise IngestError(
        f"extraction_ref.file_hash {file_hash!r} matches no incidents.json under {doc_dir}/ai/ "
        "-- review does not pin to an extraction that exists in the archive"
    )


def _validate_corrections(corrections: list[dict]) -> None:
    for correction in corrections:
        field_name = correction["field_name"]
        if field_name not in CORRECTABLE_FIELDS:
            raise IngestError(f"correction targets unknown/uncorrectable field_name {field_name!r}")


def ingest_review(doc_dir: str, review_json: dict) -> str:
    """Validates and archives `review_json` for the document at `doc_dir`. Returns
    the R2 key it was written to. Raises IngestError (nothing written) on any
    validation/pinning/range-checking failure."""
    try:
        Draft202012Validator(REVIEW_SCHEMA).validate(review_json)
    except SchemaValidationError as e:
        raise IngestError(f"schema validation failed: {e.message}") from e

    file_hash = review_json["extraction_ref"]["file_hash"]
    incident_index = review_json["extraction_ref"]["incident_index"]

    incidents_json = _find_incidents_json(doc_dir, file_hash)
    incidents = incidents_json.get("incidents") or []

    if incident_index is None:
        # Document-level review -- only valid for a genuine zero-incident extraction.
        if incidents:
            raise IngestError(
                f"extraction_ref.incident_index is null, but {doc_dir} extraction has "
                f"{len(incidents)} incident(s) -- null is reserved for zero-incident reports"
            )
    elif incident_index >= len(incidents):
        raise IngestError(
            f"extraction_ref.incident_index {incident_index} out of range -- "
            f"{doc_dir} extraction has {len(incidents)} incident(s)"
        )

    if review_json["decision"] == "corrected":
        if incident_index is None:
            raise IngestError(
                "a document-level (zero-incident) review cannot be \"corrected\" -- "
                "there is no per-field correction vocabulary for the document object; "
                "reject it instead to send the document back for re-extraction"
            )
        _validate_corrections(review_json["corrections"])

    if review_json.get("organization_review") is not None and incident_index is None:
        raise IngestError("a document-level (zero-incident) review has no organization to review")

    index_token = "document" if incident_index is None else str(incident_index)
    key = (
        f"{doc_dir}/reviews/{index_token}_"
        f"{_slugify(review_json['reviewer'])}_{_filename_ts(review_json['reviewed_at'])}.review.json"
    )
    r2.put_bytes(key, json.dumps(review_json, indent=2).encode("utf-8"))
    return key


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--doc-dir", required=True, help="archive doc dir, e.g. archive/100001_alpha-college/2026/docs/abc123")
    parser.add_argument("--review", required=True, help="path to a review.json file to ingest")
    args = parser.parse_args()

    review_json = json.loads(Path(args.review).read_text())
    try:
        key = ingest_review(args.doc_dir, review_json)
    except IngestError as e:
        print(f"REJECTED: {e}")
        return 1
    print(f"OK: wrote {key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
