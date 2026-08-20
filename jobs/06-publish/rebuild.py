"""
rebuild.py -- 06-publish: full catalog rebuild from the archive (15 tables across
`staging`/`public` — see DATABASE_SCHEMA.md and CLAUDE.md's "Catalog" section).

Rebuild is the only write path to production -- no incremental import: drops and
recreates both `staging` and `public` schemas from catalog_schema.sql, then walks the
*entire* archive and repopulates every table, in FK-dependency order:

  institution <- sources/schools.csv
  pipeline_runs <- every pipeline_runs/{run_id}.json (archive root, not prefix-scoped --
      matches jobs/02-archive/run.py's own write location)
  data_checks <- every {prefix}/{inst}/{year}/data_check.json
  ledger <- every {prefix}/{inst}/ledger/{url_hash16}.json (ledger_id = that filename's
      hash16, already a stable per-URL fingerprint -- lib.fingerprint.url_hash16)
  artifacts <- every doc dir with a manifest.json (one artifact per unique captured
      snapshot, since 02-archive already dedupes unchanged content at write time --
      artifact FKs are set at creation, not deferred)
  staging_incidents / staging_organizations <- every doc dir's CURRENT extract_v{N}
      incidents.json, one staging_incidents row per incidents[] entry (regardless of
      review status -- staging holds every candidate, not just approved ones) and one
      staging_organizations row per incident that names an organization. human_review_status
      defaults to "Pending review"/"Proposed" and is resolved from the incident's
      reviews/*.review.json if one exists.
  incidents / incident_dates / incident_organizations / incident_status_history /
      organizations / staging_incident_possible_matches / staging_incident_review_flags /
      staging_incident_corrections <- derived from the above per the promotion,
      organization-matching, and cross-year status-update rules described in CLAUDE.md
      (see _promote_all below)

Pure function of the archive: run twice against an unchanged archive and every ID and
every row comes out identical. IDs are content-derived text hashes throughout, never
SERIAL — see catalog_schema.sql's header for why this overrides DATABASE_SCHEMA.md's own
"Integer, auto-generated" field-table wording.

Timestamps are likewise never wall-clock-at-rebuild-time (that would break the
"identical archive -> identical catalog" bar row-for-row, not just ID-for-ID) — every
`created_at`/`reviewed_date`/`updated_at`/etc. column is derived from a timestamp already
recorded in some archived JSON file (manifest.fetched_at, extract_v{N}/metadata.json's
`created`, review.json's `reviewed_at`, data_check.json's `data_check_date`). The one
unavoidable exception is `institution.created_at`: sources/schools.csv carries no
"institution first tracked" timestamp at all, so this column is computed once per
`_populate()` call (not per row) and will differ across separate rebuild invocations —
a known, accepted gap, not silently glossed over.

Run: python jobs/06-publish/rebuild.py [--prefix archive/] [--schools-csv PATH]
"""
import argparse
import csv
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
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

LOW_CONFIDENCE_THRESHOLD = 0.7  # provisional per DATABASE_SCHEMA.md -- see Open questions

# corrections[].field_name values a reviewer may correct on an incident -- mirrors
# jobs/05-review/ingest.py's own CORRECTABLE_FIELDS whitelist exactly (kept as a
# separate literal here, not imported, since the two files intentionally validate the
# same contract independently -- same reasoning as ingest.ts being a port, not an import,
# of ingest.py).
CORRECTABLE_FIELDS = {
    "organization_name_raw",
    "organization_name_normalized",
    "description_raw",
    "findings_raw",
    "sanctions_raw",
    "alcohol_involved",
    "drugs_involved",
    "determination_status",
    "institutional_recognition_status",
    "dates.investigation_start_date_raw",
    "dates.investigation_start_date",
    "dates.investigation_end_date_raw",
    "dates.investigation_end_date",
    "dates.notice_date_raw",
    "dates.notice_date",
    # NOTE: incident_dates[] entries (per-occurrence start/end/precision/year/month/
    # academic_term) are corrected via a separate index-aware field_name pattern --
    # "incident_dates[N].subfield" -- not this fixed whitelist, since N varies per
    # incident. See _INCIDENT_DATES_FIELD_RE / _apply_corrections below.
}

# field_name -> the raw text field whose "Not specified"/None value means "Required
# field missing" (DATABASE_SCHEMA.md's per-field Missing value handling rules).
REQUIRED_FIELD_CHECKS = {
    "organization_name_raw": lambda inc: inc.get("organization_name_raw") is None,
    "findings_raw": lambda inc: inc.get("findings_raw") is None,
    "sanctions_raw": lambda inc: inc.get("sanctions_raw") is None,
    "dates.incident_start_raw": lambda inc: inc["dates"]["incident_start_raw"] == "Not specified",
    "dates.incident_end_raw": lambda inc: inc["dates"]["incident_end_raw"] == "Not specified",
    "dates.investigation_start_date_raw": lambda inc: inc["dates"]["investigation_start_date_raw"] == "Not specified",
    "dates.investigation_end_date_raw": lambda inc: inc["dates"]["investigation_end_date_raw"] == "Not specified",
    "dates.notice_date_raw": lambda inc: inc["dates"]["notice_date_raw"] == "Not specified",
}


def _db_url() -> str:
    url = os.environ.get("NEON_DATABASE_URL")
    if not url:
        raise RuntimeError("missing required environment variable: NEON_DATABASE_URL")
    return url


def _hash(*parts) -> str:
    """A stable, content-derived id -- short_hash(sha256(...)) of every part joined by
    '|', matching the archive's incident_id/report_id convention (see CLAUDE.md)."""
    key = "|".join("" if p is None else str(p) for p in parts)
    return short_hash(sha256_bytes(key.encode("utf-8")))


def _comparison_key(name: str) -> str:
    """Deterministic organization-name comparison key: lowercase, trim, strip
    punctuation -- applied only for matching, never changes what's stored
    (DATABASE_SCHEMA.md's "Organization name: AI cleans, pipeline copies + safety net")."""
    return "".join(ch for ch in name.lower().strip() if ch.isalnum() or ch.isspace()).split()


def _comparison_key_str(name: str) -> str:
    return " ".join(_comparison_key(name))


def read_schools(schools_csv: Path = DEFAULT_SCHOOLS_CSV) -> list[dict]:
    if not schools_csv.exists():
        return []
    with schools_csv.open(newline="") as f:
        return list(csv.DictReader(f))


# ── Archive key enumeration (mirrors status.py's own walk conventions) ─────────────

def _ledger_entry_keys(keys: set[str]) -> list[str]:
    return sorted(k for k in keys if len(k.split("/")) == 4 and k.split("/")[-2] == "ledger" and k.endswith(".json"))


def _data_check_keys(keys: set[str]) -> list[str]:
    return sorted(k for k in keys if len(k.split("/")) == 4 and k.endswith("/data_check.json"))


def _doc_dirs(keys: set[str]) -> list[str]:
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


# ── institution / pipeline_runs / data_checks / ledger / artifacts ───────────────

def _institution_rows(schools: list[dict], created_at: str) -> list[tuple]:
    return [(s["unitid"], s["name"], s.get("state") or None, None, created_at) for s in schools]


def _pipeline_run_rows(pipeline_keys: list[str]) -> list[tuple]:
    rows = []
    for key in pipeline_keys:
        run = json.loads(r2.get_bytes(key))
        rows.append((
            run["run_id"], run["prompt_version"], run["run_status"],
            run["run_started_at"], run["run_completed_at"],
        ))
    return rows


def _data_check_rows(keys: set[str]) -> list[tuple]:
    rows = []
    for key in _data_check_keys(keys):
        dc = json.loads(r2.get_bytes(key))
        data_check_id = _hash(dc["unitid"], dc["scrape_year"])
        created_at = f"{dc['data_check_date']}T00:00:00Z"
        rows.append((
            data_check_id, dc["unitid"], dc["pipeline_run_id"], dc["chtr_index_url"],
            dc["checked_by"], dc["data_check_date"], dc["pipeline_status"], created_at,
        ))
    return rows


def _ledger_rows(keys: set[str]) -> list[tuple]:
    rows = []
    for key in _ledger_entry_keys(keys):
        entry = json.loads(r2.get_bytes(key))
        ledger_id = Path(key).stem  # the {url_hash16} filename itself -- already stable
        rows.append((
            ledger_id, entry["unitid"], entry["source_url"],
            entry["first_seen_date"], entry["last_seen_date"], entry["fingerprint_content_hash"],
        ))
    return rows


_ARTIFACT_FORMAT = {"application/pdf": "PDF", "text/html": "HTML"}


def _artifact_rows(keys: set[str]) -> tuple[list[tuple], dict[str, str]]:
    """Returns (rows, {doc_dir: artifact_id})."""
    rows = []
    doc_dir_to_artifact_id: dict[str, str] = {}
    for doc_dir in _doc_dirs(keys):
        manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
        ledger_id = sha256_bytes(manifest["source_url"].encode("utf-8"))[:16]
        data_check_id = _hash(manifest["unitid"], manifest["scrape_year"])
        artifact_id = _hash(ledger_id, manifest["sha256"])
        doc_dir_to_artifact_id[doc_dir] = artifact_id
        rows.append((
            artifact_id, ledger_id, data_check_id, None,  # pipeline_run_id filled below
            doc_dir, manifest["sha256"],
            _ARTIFACT_FORMAT.get(manifest["content_type"], "Other"),
            manifest["fetched_at"],
        ))
    return rows, doc_dir_to_artifact_id


# ── Flags (recomputed fresh every rebuild -- see module docstring) ───────────────

def _recompute_flags(final_incident: dict, ai_flags: list[dict], corrected_fields: set[str]) -> list[tuple]:
    """Returns [(flag_type, field_name)]. 'Legally required field missing' and 'Low extraction
    confidence' are mechanically recomputed from the FINAL (post-correction) incident
    data every time -- pipeline-applied thresholds, per DATABASE_SCHEMA.md's Pipeline
    Logic ("Review flag conditions: model reports the value, pipeline applies the
    threshold"). The remaining three flag types (Determination unclear, Alcohol/drugs
    review needed, Unrecognized date term, Unable to determine organization type) depend
    on source-document structure the AI alone observed, not on any final scalar value --
    these are carried forward from the AI's own flags[] array and simply dropped if the
    correction that would resolve them was applied (Review & Correction pipeline logic:
    "Flags auto-clear when their condition resolves")."""
    flags: list[tuple] = []

    for field_name, is_missing in REQUIRED_FIELD_CHECKS.items():
        if is_missing(final_incident):
            flags.append(("Legally required field missing", field_name))

    if final_incident["extraction_confidence"] < LOW_CONFIDENCE_THRESHOLD:
        flags.append(("Low extraction confidence", "extraction_confidence"))

    for ai_flag in ai_flags:
        flag_type = ai_flag["flag_type"]
        if flag_type in ("Legally required field missing", "Low extraction confidence"):
            continue  # recomputed above, never carried forward stale
        if ai_flag["field_name"] in corrected_fields:
            continue  # the reviewer fixed exactly this field -- condition resolved
        flags.append((flag_type, ai_flag["field_name"]))

    return flags


# ── review.json lookup helpers ───────────────────────────────────────

def _find_review(reviews: list[dict], file_hash: str, incident_index: int) -> dict | None:
    matches = [
        r for r in reviews
        if r["extraction_ref"]["file_hash"] == file_hash
        and r["extraction_ref"]["incident_index"] == incident_index
    ]
    if not matches:
        return None
    return max(matches, key=lambda r: r["reviewed_at"])


_INCIDENT_DATES_FIELD_RE = re.compile(r"^incident_dates\[(\d+)\]\.([a-z_]+)$")


def _apply_corrections(raw_incident: dict, corrections: list[dict]) -> tuple[dict, set[str]]:
    """Returns (final_incident, corrected_field_names) -- a deep copy of raw_incident
    with every corrections[] entry applied. Unsupported field_name values are rejected
    (ingest.py already validates this at write time, per CORRECTABLE_FIELDS plus the
    incident_dates[N].subfield pattern, so this is a defense-in-depth check, not the
    primary gate)."""
    final = json.loads(json.dumps(raw_incident))
    corrected_fields: set[str] = set()
    for correction in corrections:
        field_name = correction["field_name"]
        value = correction["corrected_value"]
        if field_name in CORRECTABLE_FIELDS:
            if field_name.startswith("dates."):
                final["dates"][field_name[len("dates."):]] = value
            else:
                final[field_name] = value
        else:
            m = _INCIDENT_DATES_FIELD_RE.match(field_name)
            if m is None:
                raise ValueError(f"correction targets unknown field_name {field_name!r}")
            index, subfield = int(m.group(1)), m.group(2)
            if index >= len(final.get("incident_dates") or []):
                raise ValueError(
                    f"correction field_name {field_name!r} indexes incident_dates[{index}], out of range"
                )
            final["incident_dates"][index][subfield] = value
        corrected_fields.add(field_name)
    return final, corrected_fields


def _incident_row_key(unitid: str, incident: dict) -> str:
    """incident_id -- computed from the ORIGINAL, uncorrected extraction so a reviewer's
    typo fix never changes an incident's public id."""
    org = incident.get("organization_name_normalized") or ""
    start = incident["dates"]["incident_start_raw"]
    desc = incident["description_raw"][:200]
    return _hash(unitid, org, start, desc)


def _org_row_key(comparison_key: str) -> str:
    """organization_id -- hash of the deterministic comparison key, not the first-seen
    proposal's exact text, so it's idempotent regardless of processing order."""
    return _hash("org", comparison_key)


# ── staging_incidents / staging_organizations + promotion ────────────────────

class _RebuildState:
    """Accumulates rows for every table populated by _stage_and_promote, plus the
    in-memory registries (per-unitid incident lookup keys, global org comparison-key
    registry) that make cross-year matching and organization matching possible in a
    single archive walk -- see module docstring."""

    def __init__(self) -> None:
        self.staging_incidents: list[tuple] = []
        self.staging_organizations: list[tuple] = []
        self.incidents: dict[str, list] = {}  # incident_id -> mutable row list (for in-place updates)
        self.incident_organizations: list[tuple] = []
        self.incident_dates: list[tuple] = []
        self.incident_status_history: list[tuple] = []
        self.organizations: dict[str, tuple] = {}  # organization_id -> row
        self.possible_matches: list[tuple] = []
        self.review_flags: list[tuple] = []
        self.corrections: list[tuple] = []

        # unitid -> {"by_end_date": {date: incident_id}, "by_org_start": {(org_key, start): incident_id}}
        self._incident_lookup: dict[str, dict] = {}
        # comparison_key -> organization_id, for already-approved organizations
        self._org_registry: dict[str, str] = {}

    def _lookup_for(self, unitid: str) -> dict:
        return self._incident_lookup.setdefault(unitid, {"by_end_date": {}, "by_org_start": {}})

    def find_possible_matches(self, unitid: str, org_key: str | None, investigation_end_date, incident_start_normalized) -> list[str]:
        lookup = self._lookup_for(unitid)
        hits: list[str] = []
        if investigation_end_date is not None:
            hit = lookup["by_end_date"].get(investigation_end_date)
            if hit is not None:
                hits.append(hit)
        if org_key is not None and incident_start_normalized is not None:
            hit = lookup["by_org_start"].get((org_key, incident_start_normalized))
            if hit is not None and hit not in hits:
                hits.append(hit)
        return hits

    def register_incident(self, unitid: str, incident_id: str, org_key: str | None,
                           investigation_end_date, incident_start_normalized) -> None:
        lookup = self._lookup_for(unitid)
        if investigation_end_date is not None:
            lookup["by_end_date"][investigation_end_date] = incident_id
        if org_key is not None and incident_start_normalized is not None:
            lookup["by_org_start"][(org_key, incident_start_normalized)] = incident_id

    def match_organization(self, comparison_key: str) -> str | None:
        return self._org_registry.get(comparison_key)

    def register_organization(self, comparison_key: str, organization_id: str) -> None:
        self._org_registry[comparison_key] = organization_id


def _process_organization(state: _RebuildState, staging_incident_id: str, final: dict, org_review: dict | None,
                           reviewer: str | None, reviewed_at: str | None, extracted_at: str) -> tuple[str, str | None]:
    """Writes staging_organizations + (later) incident_organizations rows for one
    incident's organization proposal. Returns (staging_organization_id, organization_id
    or None). Only called when final['organization_name_raw'] is not None. `reviewer`/
    `reviewed_at` are the top-level review's fields (organization_review itself carries
    no reviewer identity of its own -- it's a sub-decision on the same review)."""
    staging_organization_id = _hash(staging_incident_id, "org")
    comparison_key = _comparison_key_str(final["organization_name_normalized"] or final["organization_name_raw"])
    existing_org_id = state.match_organization(comparison_key)
    match_type = "Matched existing" if existing_org_id else "New proposal"

    if org_review is not None:
        org_decision = org_review["decision"]
        org_human_status = "Approved" if org_decision in ("approved", "corrected") else "Rejected"
        corrected_type = org_review.get("corrected_organization_type")
        corrected_gender_composition = org_review.get("corrected_membership_gender_composition")
    else:
        org_human_status = "Proposed"
        corrected_type = None
        corrected_gender_composition = None
    resolved_org_type = corrected_type if corrected_type is not None else final.get("organization_type")
    membership_gender_composition = (
        corrected_gender_composition if corrected_gender_composition is not None
        else final.get("membership_gender_composition")
    )

    if existing_org_id is not None:
        organizations_row = state.organizations[existing_org_id]
        org_name = organizations_row[1]
    else:
        org_name = final["organization_name_normalized"] or final["organization_name_raw"]

    org_reviewed_by = reviewer if org_review is not None else None
    org_reviewed_date = reviewed_at if org_review is not None else None

    state.staging_organizations.append((
        staging_organization_id, org_name, resolved_org_type, match_type,
        membership_gender_composition,
        org_human_status, org_reviewed_by, org_reviewed_date, None, extracted_at,
    ))

    if resolved_org_type is None:
        state.review_flags.append((
            _hash(staging_organization_id, "Unable to determine organization type", "organization_type"),
            None, staging_organization_id, "Unable to determine organization type", "organization_type",
            None, extracted_at,
        ))

    organization_id = None
    if org_human_status == "Approved":
        if existing_org_id is not None:
            organization_id = existing_org_id
        else:
            organization_id = _org_row_key(comparison_key)
            if resolved_org_type is not None:
                state.organizations[organization_id] = (
                    organization_id, org_name, resolved_org_type, membership_gender_composition, reviewed_at,
                )
                state.register_organization(comparison_key, organization_id)

    return staging_organization_id, organization_id


def _stage_and_promote(state: _RebuildState, doc_dir: str, artifact_id: str, keys: set[str], failures: list[str]) -> None:
    version = _current_extract_version(doc_dir, keys)
    if version is None:
        return
    version_dir = f"{doc_dir}/ai/extract_v{version}"
    incidents_key, validation_key, metadata_key = (
        f"{version_dir}/incidents.json", f"{version_dir}/validation.json", f"{version_dir}/metadata.json",
    )
    if incidents_key not in keys or validation_key not in keys or metadata_key not in keys:
        return
    validation = json.loads(r2.get_bytes(validation_key))
    if not validation.get("valid"):
        return

    incidents_bytes = r2.get_bytes(incidents_key)
    incidents_json = json.loads(incidents_bytes)
    file_hash = sha256_bytes(incidents_bytes)
    metadata = json.loads(r2.get_bytes(metadata_key))
    extracted_at = metadata["created"]
    manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
    unitid = manifest["unitid"]

    reviews_prefix = f"{doc_dir}/reviews/"
    reviews = [json.loads(r2.get_bytes(k)) for k in keys if k.startswith(reviews_prefix)]

    for index, raw_incident in enumerate(incidents_json.get("incidents") or []):
        try:
            _stage_one_incident(state, doc_dir, artifact_id, unitid, manifest["scrape_year"], extracted_at,
                                 raw_incident, index, file_hash, reviews)
        except Exception as e:
            failures.append(f"{doc_dir} incident {index}: {e}")


def _stage_one_incident(state: _RebuildState, doc_dir: str, artifact_id: str, unitid: str, scrape_year: int,
                         extracted_at: str, raw_incident: dict, index: int, file_hash: str, reviews: list[dict]) -> None:
    staging_incident_id = _hash(artifact_id, index)
    review = _find_review(reviews, file_hash, index)

    if review is None:
        human_review_status = "Pending review"
        corrections, corrected_fields, org_review, reviewed_by, reviewed_date, reviewer_notes = [], set(), None, None, None, None
    else:
        decision = review["decision"]
        human_review_status = "Approved" if decision in ("approved", "corrected") else "Rejected"
        corrections = review.get("corrections") or []
        org_review = review.get("organization_review")
        reviewed_by = review["reviewer"]
        reviewed_date = review["reviewed_at"]
        reviewer_notes = None
        final, corrected_fields = (_apply_corrections(raw_incident, corrections) if decision == "corrected"
                                    else (raw_incident, set()))
    if review is None:
        final = raw_incident

    dates = final["dates"]
    incident_dates_list = final["incident_dates"]
    flags = _recompute_flags(final, raw_incident.get("flags") or [], corrected_fields)

    state.staging_incidents.append((
        staging_incident_id, artifact_id, unitid,
        final.get("organization_name_raw"), final.get("organization_name_normalized"),
        final["description_raw"],
        dates["investigation_start_date_raw"], dates["investigation_start_date"],
        dates["investigation_end_date_raw"], dates["investigation_end_date"],
        dates["notice_date_raw"], dates["notice_date"],
        final.get("sanctions_raw"), final.get("findings_raw"),
        final["determination_status"], final["institutional_recognition_status"],
        final["alcohol_involved"], final["drugs_involved"],
        final["extraction_confidence"], human_review_status,
        reviewed_by, reviewed_date, reviewer_notes, extracted_at,
    ))

    for flag_type, field_name in flags:
        state.review_flags.append((
            _hash(staging_incident_id, flag_type, field_name), staging_incident_id, None,
            flag_type, field_name, None, extracted_at,
        ))

    for correction in corrections:
        state.corrections.append((
            _hash(staging_incident_id, correction["field_name"]), staging_incident_id,
            correction["field_name"], correction.get("original_value"), correction["corrected_value"],
            correction["correction_type"], reviewed_by, reviewed_date,
        ))

    staging_organization_id = None
    organization_id = None
    if final.get("organization_name_raw") is not None:
        staging_organization_id, organization_id = _process_organization(
            state, staging_incident_id, final, org_review, reviewed_by, reviewed_date, extracted_at,
        )

    # Matching uses the FIRST incident_dates entry's start_normalized as the incident's
    # "primary" occurrence date -- a judgment call, since an incident can now have
    # multiple genuinely distinct occurrence dates (see rule 10/prompt.md). The first
    # entry is whichever the extraction listed first, typically the earliest.
    primary_start_normalized = incident_dates_list[0]["start_normalized"] if incident_dates_list else None
    org_comparison_key = (
        _comparison_key_str(final["organization_name_normalized"] or final["organization_name_raw"])
        if final.get("organization_name_raw") is not None else None
    )

    incident_id: str | None = None
    if human_review_status == "Approved":
        hits = state.find_possible_matches(
            unitid, org_comparison_key, dates["investigation_end_date"], primary_start_normalized,
        )
        best_hit = None
        for existing_incident_id in hits:
            existing_row = state.incidents[existing_incident_id]
            existing_status = existing_row[12]  # determination_status column
            match_basis = "Duplicate match" if existing_status == final["determination_status"] else "Status update to existing incident"
            state.possible_matches.append((
                _hash(staging_incident_id, existing_incident_id), staging_incident_id,
                existing_incident_id, match_basis, extracted_at,
            ))
            if match_basis == "Status update to existing incident":
                best_hit = (existing_incident_id, match_basis)
            elif best_hit is None:
                best_hit = (existing_incident_id, match_basis)

        if best_hit is not None and best_hit[1] == "Status update to existing incident":
            existing_incident_id, _ = best_hit
            existing_row = state.incidents[existing_incident_id]
            old_status = existing_row[12]
            existing_row[12] = final["determination_status"]
            existing_row[-1] = reviewed_date
            state.incident_status_history.append((
                _hash(existing_incident_id, staging_incident_id), existing_incident_id,
                staging_incident_id, old_status, final["determination_status"], reviewed_date,
            ))
            incident_id = existing_incident_id
        else:
            incident_id = _incident_row_key(unitid, raw_incident)
            state.incidents[incident_id] = [
                incident_id, unitid, staging_incident_id,
                final["description_raw"],
                dates["investigation_start_date_raw"], dates["investigation_start_date"],
                dates["investigation_end_date_raw"], dates["investigation_end_date"],
                dates["notice_date_raw"], dates["notice_date"],
                final.get("sanctions_raw"), final.get("findings_raw"),
                final["determination_status"], final["institutional_recognition_status"],
                final["alcohol_involved"], final["drugs_involved"],
                reviewed_date,
            ]
            state.register_incident(unitid, incident_id, org_comparison_key,
                                     dates["investigation_end_date"], primary_start_normalized)

    for i, d in enumerate(incident_dates_list):
        state.incident_dates.append((
            _hash(staging_incident_id, "dates", i), staging_incident_id, incident_id,
            d["start_raw"], d["start_normalized"], d["start_precision"],
            d["start_year"], d["start_month"], d["start_academic_term"],
            d["end_raw"], d["end_normalized"], d["end_precision"],
            d["end_year"], d["end_month"], d["end_academic_term"],
        ))

    if staging_organization_id is not None:
        state.incident_organizations.append((
            _hash(staging_incident_id, staging_organization_id), staging_incident_id,
            staging_organization_id, incident_id, organization_id,
        ))


def _populate(cur, prefix: str, schools_csv: Path) -> dict:
    keys = set(r2.list_keys(prefix))
    pipeline_keys = sorted(r2.list_keys("pipeline_runs/"))
    schools = read_schools(schools_csv)
    rebuild_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    institution_rows = _institution_rows(schools, rebuild_time)
    cur.executemany(
        "INSERT INTO public.institution (unitid, institution, state_territory, region, created_at) "
        "VALUES (%s, %s, %s, %s, %s)",
        institution_rows,
    )

    pipeline_run_rows = _pipeline_run_rows(pipeline_keys)
    cur.executemany(
        "INSERT INTO public.pipeline_runs (pipeline_run_id, prompt_version, run_status, run_started_at, run_completed_at) "
        "VALUES (%s, %s, %s, %s, %s)",
        pipeline_run_rows,
    )

    data_check_rows = _data_check_rows(keys)
    cur.executemany(
        "INSERT INTO public.data_checks "
        "(data_check_id, unitid, pipeline_run_id, chtr_index_url, checked_by, data_check_date, pipeline_status, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        data_check_rows,
    )

    ledger_rows = _ledger_rows(keys)
    cur.executemany(
        "INSERT INTO public.ledger (ledger_id, unitid, source_url, first_seen_date, last_seen_date, fingerprint_content_hash) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        ledger_rows,
    )

    artifact_rows, doc_dir_to_artifact_id = _artifact_rows(keys)
    # pipeline_run_id on Artifacts is frozen at creation (the run that *produced* it) --
    # approximated here as the most recent Complete/Partial-Error run whose window
    # covers the artifact's fetched_at, since 02-archive doesn't stamp this directly onto
    # manifest.json today. Falls back to the latest run if none bracket it cleanly.
    sorted_runs = sorted(pipeline_run_rows, key=lambda r: r[3])  # by run_started_at
    def _run_for(fetched_at: str) -> str | None:
        candidate = None
        for run_id, _pv, _status, started, completed in sorted_runs:
            if started <= fetched_at and (completed is None or fetched_at <= completed):
                candidate = run_id
        return candidate or (sorted_runs[-1][0] if sorted_runs else None)
    artifact_rows = [
        (aid, lid, dcid, _run_for(fetched_at), loc, hash_, fmt, fetched_at)
        for (aid, lid, dcid, _pr, loc, hash_, fmt, fetched_at) in artifact_rows
    ]
    cur.executemany(
        "INSERT INTO public.artifacts "
        "(artifact_id, ledger_id, data_check_id, pipeline_run_id, artifact_location, content_hash_snapshot, artifact_format, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        artifact_rows,
    )

    state = _RebuildState()
    failures: list[str] = []

    # Deterministic processing order: by unitid, then by scrape_year/fetched_at, so
    # earlier-year candidates are promoted before later re-scrapes of the same
    # institution can match against them (see CLAUDE.md's cross-year status-update logic).
    doc_dirs_ordered = sorted(
        _doc_dirs(keys),
        key=lambda d: (json.loads(r2.get_bytes(f"{d}/manifest.json"))["unitid"],
                       json.loads(r2.get_bytes(f"{d}/manifest.json"))["scrape_year"],
                       json.loads(r2.get_bytes(f"{d}/manifest.json"))["fetched_at"]),
    )
    for doc_dir in doc_dirs_ordered:
        artifact_id = doc_dir_to_artifact_id.get(doc_dir)
        if artifact_id is None:
            continue
        _stage_and_promote(state, doc_dir, artifact_id, keys, failures)

    cur.executemany(
        "INSERT INTO staging.staging_incidents "
        "(staging_incident_id, artifact_id, institution_unitid, organization_name_raw, organization_name_normalized, "
        " incident_description_raw, investigation_start_date_raw, investigation_start_date, "
        " investigation_end_date_raw, investigation_end_date, notice_date_raw, notice_date, "
        " sanctions_raw, findings_raw, determination_status, institutional_recognition_status, "
        " alcohol_involved, drugs_involved, "
        " extraction_confidence, human_review_status, reviewed_by, reviewed_date, reviewer_notes, created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        state.staging_incidents,
    )
    cur.executemany(
        "INSERT INTO staging.staging_organizations "
        "(staging_organization_id, organization_name, organization_type, match_type, membership_gender_composition, "
        " human_review_status, reviewed_by, reviewed_date, reviewer_notes, created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        state.staging_organizations,
    )
    cur.executemany(
        "INSERT INTO public.organizations (organization_id, organization_name, organization_type, "
        " membership_gender_composition, created_at) "
        "VALUES (%s,%s,%s,%s,%s)",
        list(state.organizations.values()),
    )
    cur.executemany(
        "INSERT INTO public.incidents "
        "(incident_id, institution_unitid, staging_incident_id, incident_description_raw, "
        " investigation_start_date_raw, investigation_start_date, investigation_end_date_raw, investigation_end_date, "
        " notice_date_raw, notice_date, sanctions_raw, findings_raw, determination_status, "
        " institutional_recognition_status, alcohol_involved, drugs_involved, updated_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        [tuple(row) for row in state.incidents.values()],
    )
    cur.executemany(
        "INSERT INTO public.incident_dates "
        "(incident_date_id, staging_incident_id, incident_id, start_date_raw, start_date_normalized, start_date_precision, "
        " start_date_year, start_date_month, start_date_academic_term, "
        " end_date_raw, end_date_normalized, end_date_precision, "
        " end_date_year, end_date_month, end_date_academic_term) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        state.incident_dates,
    )
    cur.executemany(
        "INSERT INTO public.incident_organizations "
        "(incident_organization_id, staging_incident_id, staging_organization_id, incident_id, organization_id) "
        "VALUES (%s,%s,%s,%s,%s)",
        state.incident_organizations,
    )
    cur.executemany(
        "INSERT INTO public.incident_status_history "
        "(incident_status_history_id, incident_id, staging_incident_id, old_status, new_status, changed_at) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        state.incident_status_history,
    )
    cur.executemany(
        "INSERT INTO staging.staging_incident_possible_matches "
        "(match_id, candidate_incident_id, existing_incident_id, match_basis, created_at) "
        "VALUES (%s,%s,%s,%s,%s)",
        state.possible_matches,
    )
    cur.executemany(
        "INSERT INTO staging.staging_incident_review_flags "
        "(flag_id, staging_incident_id, staging_organization_id, flag_type, field_name, resolved_at, created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
        state.review_flags,
    )
    cur.executemany(
        "INSERT INTO staging.staging_incident_corrections "
        "(staging_incident_correction_id, staging_incident_id, field_name, original_value, corrected_value, "
        " correction_type, corrected_by, corrected_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        state.corrections,
    )

    for f in failures:
        logging.error(f"rebuild: {f}")

    return {
        "institution": len(institution_rows),
        "pipeline_runs": len(pipeline_run_rows),
        "data_checks": len(data_check_rows),
        "ledger": len(ledger_rows),
        "artifacts": len(artifact_rows),
        "staging_incidents": len(state.staging_incidents),
        "staging_organizations": len(state.staging_organizations),
        "organizations": len(state.organizations),
        "incidents": len(state.incidents),
        "incident_dates": len(state.incident_dates),
        "incident_organizations": len(state.incident_organizations),
        "incident_status_history": len(state.incident_status_history),
        "possible_matches": len(state.possible_matches),
        "review_flags": len(state.review_flags),
        "corrections": len(state.corrections),
        "failed": len(failures),
    }


def run(prefix: str = DEFAULT_PREFIX, db_url: str | None = None, schools_csv: Path = DEFAULT_SCHOOLS_CSV) -> dict:
    db_url = db_url or _db_url()
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP SCHEMA IF EXISTS staging CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
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
