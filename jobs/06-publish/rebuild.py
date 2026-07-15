"""
rebuild.py -- 06-publish: full catalog rebuild from the archive.

Per IMPLEMENTATION_PLAN.md Section 12 and invariant 2 (rebuild is the only write path
to production -- no incremental import). Drops and recreates the `public` schema from
catalog_schema.sql, then walks the *entire* archive and repopulates every table:

  - institutions <- sources/schools.csv (unitid, name, state)
  - documents    <- every manifest.json
  - reporting_status <- every status.json
  - reports / incidents / incident_sanctions <- only incidents with an approved or
    corrected review.json. For each normalized document's current-version
    incidents.json + validation.json, every incidents[] entry is matched against
    reviews/*.review.json via extraction_ref.file_hash (the sha256 of incidents.json)
    and extraction_ref.incident_index -- the same hash-matching invariant status.py
    already relies on. A rejected incident, or one with no review.json yet, never
    enters `incidents`.

Zero-incident ("fast" tier) reports have no incidents[] entry to review against; since
Phase 7b, review.schema.json supports a document-level review (extraction_ref.
incident_index null) for exactly this case. An approved document-level review
produces a `reports` row with `is_zero_incident=true` and no `incidents` rows at all
(there's nothing to attach reviewer/reviewed_at to, since incidents is the only table
that carries those columns per Section 12 -- the reviewer's identity is still
permanently recorded in the archive's review.json, just not projected into Postgres).
Documents that never got a document-level review, or whose extraction has >=1
incident, follow the pre-existing per-incident path below.

Corrections: review.json's `corrections` is a flat dot-path into the fields this job
knows how to apply (see CORRECTION_FIELDS below) -- one incident-level scalar field
per catalog column. A correction naming any other path is an error for that incident
(logged, incident skipped, rest of the rebuild continues) rather than silently
ignored. When a second_review is present, its corrections are applied *after* the
first review's and win on any field both name -- it is the later, more authoritative
decision. The same last-write-wins rule applies to `decision`/`rejection_reason`: a
present second_review's decision is the one that determines whether the incident is
published. sanction_quotes is a list, not a scalar column -- corrections cannot target
it (no dot-path element in CORRECTION_FIELDS reaches it), so incident_sanctions rows
are always populated from the original (uncorrected) extraction.

incident_id / report_id are computed from the *original, uncorrected* extraction
(Section 12: "verbatim quotes make this fingerprint stable") so that fixing a
reviewer-caught typo never changes an incident's public ID or orphans its permalink.

Pure function of the archive: run twice against an unchanged archive and every ID,
and every row, comes out identical.

Run: python jobs/06-publish/rebuild.py [--prefix archive/]
"""
import argparse
import csv
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import sha256_bytes, short_hash  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_PREFIX = "archive/"
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
SCHEMA_SQL = (JOB_DIR / "catalog_schema.sql").read_text()

# Dot-path corrections vocabulary -> (incidents.json path, catalog column). Only
# incident-level scalars are correctable; sanction_quotes (a list) and any
# document-level field (reports has no per-incident review to correct it through)
# are deliberately absent.
CORRECTION_FIELDS = {
    "organization_quote.text": ("organization_quote", "text"),
    "organization_quote.page": ("organization_quote", "page"),
    "description_quote.text": ("description_quote", "text"),
    "description_quote.page": ("description_quote", "page"),
    "findings_quote.text": ("findings_quote", "text"),
    "findings_quote.page": ("findings_quote", "page"),
    "alcohol_involved": ("alcohol_involved", None),
    "drugs_involved": ("drugs_involved", None),
    "dates.incident_quote.text": (("dates", "incident_quote"), "text"),
    "dates.incident_start": (("dates",), "incident_start"),
    "dates.incident_end": (("dates",), "incident_end"),
    "dates.investigation_initiated": (("dates",), "investigation_initiated"),
    "dates.resolved": (("dates",), "resolved"),
}


def _db_url() -> str:
    url = os.environ.get("NEON_DATABASE_URL")
    if not url:
        raise RuntimeError("missing required environment variable: NEON_DATABASE_URL")
    return url


def read_schools(schools_csv: Path = DEFAULT_SCHOOLS_CSV) -> list[dict]:
    if not schools_csv.exists():
        return []
    with schools_csv.open(newline="") as f:
        return list(csv.DictReader(f))


def _status_dirs(keys: set[str]) -> list[str]:
    """Keys for every status.json (`{prefix}{inst}/{year}/status.json`)."""
    return sorted(k for k in keys if k.endswith("/status.json") and len(k.split("/")) == 4)


def _doc_dirs(keys: set[str]) -> list[str]:
    """Doc directories (`{prefix}{inst}/{year}/docs/{hash16}`) that have a manifest.json."""
    doc_dirs = set()
    for key in keys:
        parts = key.split("/")
        if len(parts) == 6 and parts[3] == "docs" and parts[-1] == "manifest.json":
            doc_dirs.add("/".join(parts[:5]))
    return sorted(doc_dirs)


def _current_extract_version(doc_dir: str, keys: set[str]) -> int | None:
    prefix = f"{doc_dir}/ai/extract_v"
    versions = []
    for key in keys:
        if key.startswith(prefix) and key.endswith("/incidents.json"):
            n_str = key[len(prefix):].split("/", 1)[0]
            if n_str.isdigit():
                versions.append(int(n_str))
    return max(versions, default=None)


def _parse_bool(value: str) -> bool:
    if value.lower() not in ("true", "false"):
        raise ValueError(f"boolean correction must be \"true\" or \"false\", got {value!r}")
    return value.lower() == "true"


def _apply_correction(incident: dict, path: str, value: str) -> None:
    field = CORRECTION_FIELDS.get(path)
    if field is None:
        raise ValueError(f"unsupported correction path: {path!r}")
    container_path, leaf = field
    if leaf is None:
        # scalar boolean field directly on the incident, e.g. "alcohol_involved" --
        # review.schema.json's corrections values are always strings, so this is the
        # one field type that needs converting before it reaches a boolean column.
        incident[container_path] = _parse_bool(value)
        return
    node = incident
    keys = container_path if isinstance(container_path, tuple) else (container_path,)
    for k in keys:
        node = node[k]
    if leaf in ("text", "page") and node is None:
        raise ValueError(f"correction {path!r} targets a null quote")
    node[leaf] = value


def _resolved_decision(review: dict) -> tuple[str, dict]:
    """(decision, corrections) after applying the last-write-wins rule between the
    first review and its second_review, per this module's docstring."""
    corrections = dict(review.get("corrections") or {})
    decision = review["decision"]
    second = review.get("second_review")
    if second is not None:
        decision = second["decision"]
        corrections.update(second.get("corrections") or {})
    return decision, corrections


def _incident_id(unitid: str, incident: dict) -> str:
    org = (incident.get("organization_quote") or {}).get("text", "")
    inc_quote = (incident.get("dates") or {}).get("incident_quote") or {}
    inc_text = inc_quote.get("text", "")
    desc = incident["description_quote"]["text"][:200]
    return short_hash(sha256_bytes(f"{unitid}|{org}|{inc_text}|{desc}".encode("utf-8")))


def _report_id(content_hash: str, period_start, period_end) -> str:
    key = f"{content_hash}|{period_start or ''}|{period_end or ''}"
    return short_hash(sha256_bytes(key.encode("utf-8")))


def _find_review(reviews: list[dict], file_hash: str, incident_index: int) -> dict | None:
    matches = [
        r for r in reviews
        if r["extraction_ref"]["file_hash"] == file_hash
        and r["extraction_ref"]["incident_index"] == incident_index
    ]
    if not matches:
        return None
    return max(matches, key=lambda r: r["reviewed_at"])


def _find_document_review(reviews: list[dict], file_hash: str) -> dict | None:
    """Same as _find_review but for a document-level review (extraction_ref.
    incident_index null) -- the only way to review a "fast"-tier zero-incident
    report, which has no incidents[] entry to index (Phase 7b)."""
    matches = [
        r for r in reviews
        if r["extraction_ref"]["file_hash"] == file_hash
        and r["extraction_ref"]["incident_index"] is None
    ]
    if not matches:
        return None
    return max(matches, key=lambda r: r["reviewed_at"])


def _institution_rows(schools: list[dict]) -> list[tuple]:
    return [(s["unitid"], s["name"], s.get("state") or None) for s in schools]


def _reporting_status_rows(keys: set[str]) -> list[tuple]:
    rows = []
    for key in _status_dirs(keys):
        status = json.loads(r2.get_bytes(key))
        rows.append((status["unitid"], status["scrape_year"], status["status"], status["source_url"]))
    return rows


def _document_row(doc_dir: str, keys: set[str]) -> tuple:
    manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
    text_key = f"{doc_dir}/extracted/text.txt"
    has_text_layer = text_key in keys and bool(r2.get_bytes(text_key).strip())
    return (
        manifest["sha256"],
        manifest["unitid"],
        doc_dir,
        manifest["source_url"],
        manifest["fetched_at"],
        manifest["scrape_year"],
        has_text_layer,
    )


def _report_and_incident_rows(doc_dir: str, keys: set[str], failures: list[str]) -> tuple[tuple | None, list[tuple], list[tuple]]:
    """Returns (report_row_or_None, incident_rows, incident_sanction_rows) for one
    document, or (None, [], []) if it has no approved/corrected incident."""
    version = _current_extract_version(doc_dir, keys)
    if version is None:
        return None, [], []
    version_dir = f"{doc_dir}/ai/extract_v{version}"
    incidents_key = f"{version_dir}/incidents.json"
    validation_key = f"{version_dir}/validation.json"
    if incidents_key not in keys or validation_key not in keys:
        return None, [], []

    incidents_bytes = r2.get_bytes(incidents_key)
    validation = json.loads(r2.get_bytes(validation_key))
    if not validation.get("valid"):
        return None, [], []

    incidents_json = json.loads(incidents_bytes)
    file_hash = sha256_bytes(incidents_bytes)
    manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
    unitid = manifest["unitid"]
    content_hash = manifest["sha256"]

    reviews_prefix = f"{doc_dir}/reviews/"
    reviews = [json.loads(r2.get_bytes(k)) for k in keys if k.startswith(reviews_prefix)]

    incident_rows, sanction_rows = [], []
    for index, raw_incident in enumerate(incidents_json.get("incidents") or []):
        review = _find_review(reviews, file_hash, index)
        if review is None:
            continue
        try:
            decision, corrections = _resolved_decision(review)
            if decision not in ("approved", "corrected"):
                continue

            incident_id = _incident_id(unitid, raw_incident)

            final = json.loads(json.dumps(raw_incident))  # deep copy
            for path, value in corrections.items():
                _apply_correction(final, path, value)

            org = final.get("organization_quote") or {}
            desc = final["description_quote"]
            findings = final.get("findings_quote") or {}
            dates = final.get("dates") or {}
            inc_quote = dates.get("incident_quote") or {}

            incident_rows.append((
                incident_id,
                None,  # report_id, filled in once the report row is known
                org.get("text"),
                org.get("page"),
                desc["text"],
                desc.get("page"),
                findings.get("text"),
                findings.get("page"),
                final.get("alcohol_involved"),
                final.get("drugs_involved"),
                inc_quote.get("text"),
                dates.get("incident_start"),
                dates.get("incident_end"),
                dates.get("investigation_initiated"),
                dates.get("resolved"),
                review["reviewer"],
                review["reviewed_at"],
                (review.get("second_review") or {}).get("reviewer"),
            ))
            for sanction in raw_incident.get("sanction_quotes") or []:
                sanction_rows.append((incident_id, sanction["text"], sanction.get("page")))
        except Exception as e:
            failures.append(f"{doc_dir} incident {index}: {e}")

    if incident_rows:
        document = incidents_json.get("document") or {}
        report_id = _report_id(content_hash, document.get("reporting_period_start"), document.get("reporting_period_end"))
        report_row = (
            report_id,
            content_hash,
            document.get("reporting_period_start"),
            document.get("reporting_period_end"),
            document.get("publication_date"),
            False,
        )
        incident_rows = [row[:1] + (report_id,) + row[2:] for row in incident_rows]
        return report_row, incident_rows, sanction_rows

    # Zero-incident ("fast" tier) report: no incidents[] to review individually --
    # a document-level review (extraction_ref.incident_index null, Phase 7b) approves
    # or rejects the whole document instead. "corrected" can't occur here (ingest.py
    # rejects it -- no per-field correction vocabulary for the document object), and
    # an unresolved "escalated" is excluded the same way an undecided incident is.
    if not (incidents_json.get("incidents") or []) and (validation.get("document") or {}).get("tier") == "fast":
        doc_review = _find_document_review(reviews, file_hash)
        if doc_review is not None:
            try:
                decision, _ = _resolved_decision(doc_review)
                if decision == "approved":
                    document = incidents_json.get("document") or {}
                    report_id = _report_id(
                        content_hash, document.get("reporting_period_start"), document.get("reporting_period_end")
                    )
                    report_row = (
                        report_id,
                        content_hash,
                        document.get("reporting_period_start"),
                        document.get("reporting_period_end"),
                        document.get("publication_date"),
                        True,
                    )
                    return report_row, [], []
            except Exception as e:
                failures.append(f"{doc_dir} document-level review: {e}")

    return None, [], []


def _populate(cur, prefix: str, schools_csv: Path) -> dict:
    keys = set(r2.list_keys(prefix))
    schools = read_schools(schools_csv)

    institution_rows = _institution_rows(schools)
    cur.executemany("INSERT INTO institutions (unitid, name, state) VALUES (%s, %s, %s)", institution_rows)

    status_rows = _reporting_status_rows(keys)
    cur.executemany(
        "INSERT INTO reporting_status (unitid, scrape_year, status, source_url) VALUES (%s, %s, %s, %s)",
        status_rows,
    )

    doc_dirs = _doc_dirs(keys)
    document_rows = [_document_row(doc_dir, keys) for doc_dir in doc_dirs]
    cur.executemany(
        """INSERT INTO documents
           (content_hash, unitid, storage_key, source_url, fetched_at, scrape_year, has_text_layer)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        document_rows,
    )

    failures: list[str] = []
    report_rows, incident_rows, sanction_rows = [], [], []
    for doc_dir in doc_dirs:
        report_row, inc_rows, san_rows = _report_and_incident_rows(doc_dir, keys, failures)
        if report_row is not None:
            report_rows.append(report_row)
            incident_rows.extend(inc_rows)
            sanction_rows.extend(san_rows)

    cur.executemany(
        """INSERT INTO reports (report_id, content_hash, period_start, period_end, publication_date, is_zero_incident)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        report_rows,
    )
    cur.executemany(
        """INSERT INTO incidents
           (incident_id, report_id, organization_text, organization_page, description_text, description_page,
            findings_text, findings_page, alcohol_involved, drugs_involved, incident_date_text,
            incident_start, incident_end, investigation_initiated, resolved, reviewer, reviewed_at, second_reviewer)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        incident_rows,
    )
    cur.executemany(
        "INSERT INTO incident_sanctions (incident_id, sanction_text, page) VALUES (%s, %s, %s)",
        sanction_rows,
    )

    for f in failures:
        logging.error(f"rebuild: {f}")

    return {
        "institutions": len(institution_rows),
        "reporting_status": len(status_rows),
        "documents": len(document_rows),
        "reports": len(report_rows),
        "incidents": len(incident_rows),
        "incident_sanctions": len(sanction_rows),
        "failed": len(failures),
    }


def run(prefix: str = DEFAULT_PREFIX, db_url: str | None = None, schools_csv: Path = DEFAULT_SCHOOLS_CSV) -> dict:
    db_url = db_url or _db_url()
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            cur.execute(SCHEMA_SQL)
            counts = _populate(cur, prefix, schools_csv)
        conn.commit()
    logging.info(f"rebuild complete: {counts}")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--schools-csv", default=str(DEFAULT_SCHOOLS_CSV))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(prefix=args.prefix, schools_csv=Path(args.schools_csv))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
