"""
ingest.py -- 05-review: validate and archive one review.json (the review Worker's
write path). Per IMPLEMENTATION_PLAN.md Section 10 (review.json), Section 11 (review
app), Section 15 (credentials), and Section 16's Phase 7a smoke check.

This phase builds `ingest_review()` as pure, locally-testable Python -- no real
Cloudflare Worker, wrangler config, or Access wiring yet (confirmed with the user:
no live R2/Cloudflare credentials exist in .env, and every smoke check so far runs
against ARCHIVE_LOCAL_ROOT, same as Phases 1-6). A Worker can't run Python, so the
eventual Worker will port this validation logic to TypeScript (or shell out to a
small HTTP-callable wrapper around it) once real credentials and Access exist --
that wiring is a separate follow-up phase, not this one. Until then, this module IS
the review write path: anything that can call `ingest_review()` (a script, a test, a
future Worker's embedded logic) gets the exact same guarantees.

`ingest_review(doc_dir, review_json)` does exactly what Section 10/16 require, in
order, and never partially writes:
  1. Validates `review_json` against schemas/review.schema.json (unknown fields
     rejected, since that schema is `additionalProperties: false`).
  2. Confirms `extraction_ref.file_hash` really is the sha256 of some
     `ai/extract_v{N}/incidents.json` under `doc_dir` -- pinning the decision to
     that exact extraction (invariant 9): a later re-extraction writes a *new*
     version file, so an old review's file_hash still resolves to the exact bytes
     it reviewed, never silently reassigned to the new one. Searches every version
     under `doc_dir`, not just the current one, since the review may have been
     submitted against an older extraction than whatever is "current" now.
  3. Confirms `extraction_ref.incident_index` is in range for that extraction's
     `incidents[]`.
  4. If the *resolved* decision (second_review's decision wins over the first's,
     same last-write-wins rule jobs/06-publish/rebuild.py already uses) is
     "corrected": re-runs `lib.quotes.anchor_quote` on every quote-bearing field a
     correction touches (organization_quote, description_quote, findings_quote,
     dates.incident_quote) -- a reviewer can never introduce unanchored text.
  5. Writes the review to `{doc_dir}/reviews/{incident_index}_{reviewer-slug}_{ts}
     .review.json` (Section 6). Never overwrites: the archive is append-only, and a
     later dual-review resolution (embedding `second_review`) is submitted as a new
     file with a later `reviewed_at`, exactly as jobs/06-publish/rebuild.py already
     assumes when picking the latest-`reviewed_at` match per incident.

`doc_dir` is supplied by the caller, not read out of review.json -- review.schema.json
(fixed in Phase 0, `additionalProperties: false`) has no such field, and the review
app already knows it from the catalog's queue view (`documents.storage_key`, Section
12). This is a design decision made this session, not something the plan states
explicitly: the future Worker's request shape (e.g. a route parameter) is expected to
carry `doc_dir` alongside the review.json body.

Reviewer identity: Section 11 says `reviewer` comes from the Access JWT, but Access
isn't wired up this phase (confirmed with the user). `ingest_review()` trusts whatever
`reviewer` string it's handed -- verifying it against a real signed identity is the
future Worker's job once Access exists, not this module's.

reviewer-slug / ts (Section 6's filename): lowercase `reviewer`, non-alphanumeric runs
collapsed to a single `-`, leading/trailing `-` stripped; `ts` is `reviewed_at`
reformatted to a compact filename-safe UTC form (colons/punctuation stripped), e.g.
"jane@x.edu" + "2026-07-12T15:30:00Z" -> "jane-x-edu" + "20260712T153000Z". Confirmed
with the user (they deferred to this as a sensible default) this session.

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
from lib.quotes import anchor_quote  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
REVIEW_SCHEMA = json.loads((ROOT / "schemas" / "review.schema.json").read_text())

# review.json's `corrections` dot-paths that target a verbatim quote's text/page.
# Mirrors jobs/06-publish/rebuild.py's CORRECTION_FIELDS vocabulary for the same four
# quote-bearing fields -- sanction_quotes (a list) and any document-level field are
# not correctable through review.json (a review is scoped to one incident), so
# neither needs re-anchoring here either.
QUOTE_FIELDS = {
    "organization_quote": ("organization_quote.text", "organization_quote.page"),
    "description_quote": ("description_quote.text", "description_quote.page"),
    "findings_quote": ("findings_quote.text", "findings_quote.page"),
    "dates.incident_quote": ("dates.incident_quote.text", "dates.incident_quote.page"),
}


class IngestError(ValueError):
    """review_json failed validation, hash-pinning, range-checking, or anchoring --
    ingest_review() never writes anything when this is raised."""


def _slugify(reviewer: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", reviewer.lower()).strip("-")
    return slug or "reviewer"


def _filename_ts(reviewed_at: str) -> str:
    dt = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _get_path(obj: dict, dotted: str):
    node = obj
    for key in dotted.split("."):
        if node is None:
            return None
        node = node.get(key)
    return node


def _resolved_decision(review: dict) -> tuple[str, dict]:
    """(decision, corrections) after second_review's last-write-wins override --
    same rule jobs/06-publish/rebuild.py applies at read time; ingest.py applies it
    at write time so what gets anchored matches what rebuild.py will later trust."""
    corrections = dict(review.get("corrections") or {})
    decision = review["decision"]
    second = review.get("second_review")
    if second is not None:
        decision = second["decision"]
        corrections.update(second.get("corrections") or {})
    return decision, corrections


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


def _reanchor_corrections(incident: dict, corrections: dict, document_text: str) -> None:
    for field_path, (text_key, page_key) in QUOTE_FIELDS.items():
        if text_key not in corrections and page_key not in corrections:
            continue
        original = _get_path(incident, field_path) or {}
        text = corrections.get(text_key, original.get("text"))
        page = corrections.get(page_key, original.get("page"))
        if page is not None and not isinstance(page, int):
            try:
                page = int(page)
            except (TypeError, ValueError):
                raise IngestError(f"correction {page_key!r} must be an integer page number, got {page!r}")
        if not text:
            raise IngestError(f"correction touching {field_path!r} targets a null/empty quote")

        result = anchor_quote(text, page, document_text)
        if not result["anchored"]:
            raise IngestError(
                f"corrected {field_path} (\"{text[:80]}\") no longer anchors in the document's extracted text"
            )


def ingest_review(doc_dir: str, review_json: dict) -> str:
    """Validates and archives `review_json` for the document at `doc_dir`. Returns
    the R2 key it was written to. Raises IngestError (nothing written) on any
    validation/pinning/anchoring failure."""
    try:
        Draft202012Validator(REVIEW_SCHEMA).validate(review_json)
    except SchemaValidationError as e:
        raise IngestError(f"schema validation failed: {e.message}") from e

    file_hash = review_json["extraction_ref"]["file_hash"]
    incident_index = review_json["extraction_ref"]["incident_index"]

    incidents_json = _find_incidents_json(doc_dir, file_hash)
    incidents = incidents_json.get("incidents") or []
    if incident_index >= len(incidents):
        raise IngestError(
            f"extraction_ref.incident_index {incident_index} out of range -- "
            f"{doc_dir} extraction has {len(incidents)} incident(s)"
        )

    decision, corrections = _resolved_decision(review_json)
    if decision == "corrected":
        document_text = r2.get_bytes(f"{doc_dir}/extracted/text.txt").decode("utf-8", errors="replace")
        _reanchor_corrections(incidents[incident_index], corrections, document_text)

    key = (
        f"{doc_dir}/reviews/{incident_index}_"
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
