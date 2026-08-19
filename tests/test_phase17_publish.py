"""Phase 17 smoke check: jobs/06-publish/catalog_schema.sql + rebuild.py (v3.0, 15 tables).

Replaces the stale, pre-v3.0 tests/test_phase5_publish.py (six-table schema; removed
this phase) as the official automated regression coverage for 06-publish -- Phase 16's
own sanity round-trip that exercised these paths was a throwaway script, never committed.

Builds a real archive the same way test_phase4_extract.py does (crawl + normalize
fixtures/crawl_pages/ via 02/03, make_packets.py + hand-authored incidents.json standing
in for the agent, then validate.py), then hand-adds three more institutions directly to
the archive -- mirroring test_phase4/5's own "_add_hillcrest" precedent -- for scenarios
crawl_pages can't produce: a genuine zero-incident report, a cross-year re-extraction,
and a second organization proposal that should match an already-approved one. Reviews are
submitted through jobs/05-review/ingest.py's real ingest_review() (not hand-written
review.json files), so the write path gets exercised too.

Institutions and what each one covers:
  - 200001 north-ridge-college (crawled): two incidents --
      incident 0 "Sigma Alpha Fraternity": approved, unmodified, carries an AI-reported
        "Alcohol/drugs review needed" flag that nothing corrects -- proves a
        source-structure-only flag type survives into staging_incident_review_flags.
        Its organization proposal is the *first* approval of "Sigma Alpha" this rebuild,
        so it must be registered as a "New proposal".
      incident 1 "Women's Club Rowing": rejected -- proves a rejected incident never
        reaches public.incidents regardless of its (independent) organization decision.
  - 200002 eastview-university (crawled): real CHTR PDF, decoy PDF, index page --
      the real CHTR PDF's one incident ("Zeta Psi Fraternity") is `corrected`
      (determination_status "Determined hazing" -> "Dismissed"), proving (a) the
      correction lands in both staging_incidents and public.incidents, (b) incident_id
      is still computed from the *original* raw extraction (verified against
      rebuild._incident_row_key directly), and (c) correcting determination_status
      clears the AI's own "Determination unclear" flag on that exact field while the
      mechanically-recomputed "Low extraction confidence" flag (confidence 0.5) is
      unaffected by the correction and still fires.
      The decoy PDF is deliberately schema-invalid (unknown top-level field) -- proves
      an invalid extraction is skipped by rebuild.py entirely (never staged).
  - 200003 westfield-institute (crawled): one incident ("Rho Delta Chapter") with a null
      findings_raw and *no review.json at all* -- proves (a) an unreviewed incident's
      "Legally required field missing" flag is mechanically recomputed even though the AI
      itself never flagged it, and (b) an unreviewed incident never reaches public.incidents.
  - 200004 centerville-tech (crawled): no hazing signal anywhere -- not_found, no
      documents; institution row only.
  - 200005 no-report-academy (crawled): url_status=no_url -- never fetched.
  - 200006 hillcrest-academy (hand-added): a genuine zero-incident report, approved via
      a document-level review (extraction_ref.incident_index null). Per Phase 9's
      confirmed design, v3.0 has no reports/is_zero_incident concept -- proves this
      correctly produces zero staging_incidents/incidents rows (nothing to stage) while
      still getting its own artifacts row.
  - 200007 ridgeview-college (hand-added, two scrape years): the cross-year "Status
      update to existing incident" path -- year 2026's incident is "Pending" with no
      investigation_end_date yet; year 2027 re-reports the *same* incident (same
      organization + incident_start_normalized) now "Determined hazing" with a real
      investigation_end_date. Proves the year-2027 extraction updates the existing
      public.incidents row in place (no duplicate), writes one incident_status_history
      row, and that incidents.staging_incident_id stays frozen at year 2026's staging
      row, not repointed to year 2027's.
  - 200009 fairview-college (hand-added): an incident proposing "Sigma Alpha Fraternity"
      again, approved *after* north-ridge's in processing order (unitid "200009" sorts
      after "200001") -- proves it is matched ("Matched existing") against the
      already-approved organization from north-ridge rather than creating a duplicate
      public.organizations row.

Runs rebuild.py twice against a scratch local Postgres database and asserts every row
across all 15 tables is byte-identical between the two runs, except institution.created_at,
which is the one accepted non-reproducible column (sources/schools.csv carries no "first
tracked" timestamp, so it's stamped once per rebuild() call, not derived from archived
data) -- see rebuild.py's module docstring.

Run with: .venv/bin/python tests/test_phase17_publish.py
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import sha256_bytes, short_hash  # noqa: E402

FIXTURES = ROOT / "fixtures" / "crawl_pages"


def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def _start_server(directory: Path):
    handler = partial(_QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── incidents.json fixture builders (v2 shape, post incident_dates-array redesign) ──
# Updated 2026-08-19: organization_type moved to current 18-term vocabulary;
# membership_gender_composition / institutional_recognition_status added (didn't exist
# before); the old single flat `dates` block (incident_start_raw/incident_end_raw etc.)
# split into `dates` (investigation_start/investigation_end/notice only) plus a
# top-level `incident_dates` array, one entry per incident here since none of these
# fixtures model a multi-occurrence pattern -- see prompt.md rule 10 for the full
# array design. Also: `_BLANK_DATES` used to default missing _raw fields to the string
# "Not specified", which violates rule 1 (a _raw field is genuinely nullable and never
# uses a sentinel string) -- defaults below are real None.

_BLANK_INVESTIGATION_DATES = {
    "investigation_start_date_raw": None, "investigation_start_date": None,
    "investigation_end_date_raw": None, "investigation_end_date": None,
    "notice_date_raw": None, "notice_date": None,
}


def _incident(org_raw, org_normalized, org_type, gender_composition, recognition_status,
              description, findings, sanctions, alcohol, drugs, determination,
              investigation_dates, incident_dates, confidence, flags):
    return {
        "organization_name_raw": org_raw,
        "organization_name_normalized": org_normalized,
        "organization_type": org_type,
        "membership_gender_composition": gender_composition,
        "institutional_recognition_status": recognition_status,
        "description_raw": description,
        "findings_raw": findings,
        "sanctions_raw": sanctions,
        "alcohol_involved": alcohol,
        "drugs_involved": drugs,
        "determination_status": determination,
        "dates": {**_BLANK_INVESTIGATION_DATES, **investigation_dates},
        "incident_dates": incident_dates,
        "extraction_confidence": confidence,
        "flags": flags,
    }


def _document(start=None, end=None, publication=None, zero_statement=None):
    return {
        "reporting_period_start": start,
        "reporting_period_end": end,
        "publication_date": publication,
        "zero_incidents_statement": zero_statement,
    }


NR_SIGMA = _incident(
    "Sigma Alpha Fraternity", "Sigma Alpha", "Social fraternity or sorority",
    "All-male", "Recognized",
    "new members of Sigma Alpha Fraternity were required to perform physically "
    "demanding tasks late at night as part of an unofficial initiation ritual.",
    "The organization was investigated and found responsible for hazing.",
    "Sanction: probation through Fall 2026.",
    "No", "No", "Determined hazing",
    {"investigation_start_date_raw": "October 1, 2025", "investigation_start_date": "2025-10-01",
     "investigation_end_date_raw": "November 15, 2025", "investigation_end_date": "2025-11-15",
     "notice_date_raw": "November 20, 2025", "notice_date": "2025-11-20"},
    [{"start_raw": "September 2025", "start_normalized": None, "start_precision": "Month",
      "start_year": 2025, "start_month": 9, "start_academic_term": None,
      "end_raw": "September 2025", "end_normalized": None, "end_precision": "Month",
      "end_year": 2025, "end_month": 9, "end_academic_term": None}],
    0.9,
    [{"flag_type": "Alcohol/drugs review needed", "field_name": "alcohol_involved",
      "note": "narrative is ambiguous about alcohol despite the reported 'No'"}],
)

NR_ROWING = _incident(
    "Women's Club Rowing", "Women's Club Rowing", "Club sport",
    "All-female", "Recognized",
    "members of the Women's Club Rowing team required new members to consume "
    "alcohol at a team event.",
    "The organization was found responsible for hazing.",
    "Sanction: loss of club-sport funding for one year.",
    "Yes", "Not specified", "Determined hazing",
    {"investigation_start_date_raw": "November 1, 2025", "investigation_start_date": "2025-11-01",
     "investigation_end_date_raw": "December 1, 2025", "investigation_end_date": "2025-12-01",
     "notice_date_raw": "December 5, 2025", "notice_date": "2025-12-05"},
    [{"start_raw": "October 2025", "start_normalized": None, "start_precision": "Month",
      "start_year": 2025, "start_month": 10, "start_academic_term": None,
      "end_raw": "October 2025", "end_normalized": None, "end_precision": "Month",
      "end_year": 2025, "end_month": 10, "end_academic_term": None}],
    0.88,
    [],
)

EV_ZETA = _incident(
    "Zeta Psi Fraternity", "Zeta Psi", "Social fraternity or sorority",
    "All-male", "Recognized",
    "During Fall 2025 recruitment, new members were required to consume alcohol "
    "during a pledge event.",
    "The organization was investigated and found responsible for hazing.",
    "Sanction: suspension through Spring 2027.",
    "Yes", "Not specified", "Determined hazing",
    {"investigation_start_date_raw": "November 2, 2025", "investigation_start_date": "2025-11-02",
     "investigation_end_date_raw": "January 10, 2026", "investigation_end_date": "2026-01-10",
     "notice_date_raw": "January 10, 2026", "notice_date": "2026-01-10"},
    [{"start_raw": "Fall 2025", "start_normalized": None, "start_precision": "Academic term",
      "start_year": 2025, "start_month": None, "start_academic_term": "Fall",
      "end_raw": "Fall 2025", "end_normalized": None, "end_precision": "Academic term",
      "end_year": 2025, "end_month": None, "end_academic_term": "Fall"}],
    0.5,
    [{"flag_type": "Determination unclear", "field_name": "determination_status",
      "note": "Sanction wording is terse; moderate confidence in segmentation."}],
)

WF_RHODELTA = _incident(
    "Rho Delta Chapter", "Rho Delta", "Social fraternity or sorority",
    "Unknown/Not stated", "Recognized",
    "Unable to fully confirm details against a scanned page image; a hazing "
    "incident involving Rho Delta Chapter was reported.",
    None,  # findings_raw missing -- "Legally required field missing" mechanically recomputed
    "Sanction: written warning.",
    "Not specified", "Not specified", "Pending",
    {"investigation_start_date_raw": "April 1, 2025", "investigation_start_date": "2025-04-01"},
    [{"start_raw": "Spring 2025", "start_normalized": None, "start_precision": "Academic term",
      "start_year": 2025, "start_month": None, "start_academic_term": "Spring",
      "end_raw": "Spring 2025", "end_normalized": None, "end_precision": "Academic term",
      "end_year": 2025, "end_month": None, "end_academic_term": "Spring"}],
    0.8,
    [],
)

RV_2026 = _incident(
    "Ridgeview Rugby Club", "Ridgeview Rugby", "Club sport",
    "Unknown/Not stated", "Recognized",
    "members of the Ridgeview Rugby Club required new players to undergo a "
    "hazardous initiation run at a preseason retreat.",
    "An investigation into the incident is ongoing.",
    None,
    "Not specified", "Not specified", "Pending",
    {"investigation_start_date_raw": "September 20, 2025", "investigation_start_date": "2025-09-20"},
    [{"start_raw": "September 5, 2025", "start_normalized": "2025-09-05", "start_precision": "Day",
      "start_year": 2025, "start_month": 9, "start_academic_term": None,
      "end_raw": "September 5, 2025", "end_normalized": "2025-09-05", "end_precision": "Day",
      "end_year": 2025, "end_month": 9, "end_academic_term": None}],
    0.85,
    [],
)

RV_2027 = _incident(
    "Ridgeview Rugby Club", "Ridgeview Rugby", "Club sport",
    "Unknown/Not stated", "Recognized",
    "members of the Ridgeview Rugby Club required new players to undergo a "
    "hazardous initiation run at a preseason retreat.",
    "The organization was investigated and found responsible for hazing.",
    "Sanction: suspension of team activities for one semester.",
    "Not specified", "Not specified", "Determined hazing",
    {"investigation_start_date_raw": "September 20, 2025", "investigation_start_date": "2025-09-20",
     "investigation_end_date_raw": "March 1, 2026", "investigation_end_date": "2026-03-01",
     "notice_date_raw": "March 5, 2026", "notice_date": "2026-03-05"},
    [{"start_raw": "September 5, 2025", "start_normalized": "2025-09-05", "start_precision": "Day",
      "start_year": 2025, "start_month": 9, "start_academic_term": None,
      "end_raw": "September 5, 2025", "end_normalized": "2025-09-05", "end_precision": "Day",
      "end_year": 2025, "end_month": 9, "end_academic_term": None}],
    0.9,
    [],
)

FV_SIGMA = _incident(
    "Sigma Alpha Fraternity", "Sigma Alpha", "Social fraternity or sorority",
    "All-male", "Recognized",
    "new members of the Fairview College chapter of Sigma Alpha Fraternity were "
    "required to complete an unsanctioned late-night ritual.",
    "The organization was investigated and found responsible for hazing.",
    "Sanction: social probation through Spring 2026.",
    "No", "No", "Determined hazing",
    {"investigation_start_date_raw": "November 1, 2025", "investigation_start_date": "2025-11-01",
     "investigation_end_date_raw": "December 1, 2025", "investigation_end_date": "2025-12-01",
     "notice_date_raw": "December 5, 2025", "notice_date": "2025-12-05"},
    [{"start_raw": "October 2025", "start_normalized": None, "start_precision": "Month",
      "start_year": 2025, "start_month": 10, "start_academic_term": None,
      "end_raw": "October 2025", "end_normalized": None, "end_precision": "Month",
      "end_year": 2025, "end_month": 10, "end_academic_term": None}],
    0.92,
    [],
)


def _incidents_for(unitid: str, source_url: str, content_type: str) -> dict:
    if unitid == "200001":
        return {"schema_version": 2, "is_chtr": True,
                 "document": _document("2025-01-01", "2025-12-31"),
                 "incidents": [NR_SIGMA, NR_ROWING]}
    if unitid == "200002" and content_type == "application/pdf" and "decoy" not in source_url:
        return {"schema_version": 2, "is_chtr": True,
                 "document": _document("2025-01-01", "2025-12-31"),
                 "incidents": [EV_ZETA]}
    if unitid == "200002":
        is_decoy = "decoy" in source_url
        doc = {"schema_version": 2, "is_chtr": False, "document": _document(), "incidents": []}
        if is_decoy:
            doc["unexpected_top_level_field"] = "this violates additionalProperties: false"
        return doc
    if unitid == "200003":
        return {"schema_version": 2, "is_chtr": True, "document": _document(), "incidents": [WF_RHODELTA]}
    raise AssertionError(f"no fixture incidents.json defined for unitid {unitid!r} / {source_url!r}")


def _finish_crawled_packets(tasks_dir: Path) -> int:
    """Finishes packets for the crawled institutions (200001-200003) -- dispatches on
    unitid/source_url/content_type, same pattern as test_phase4_extract.py."""
    finished = 0
    for packet_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        metadata = json.loads((packet_dir / "metadata.json").read_text())
        doc_dir = metadata["doc_dir"]
        if "/2027/" in doc_dir or any(h in doc_dir for h in ("hillcrest", "ridgeview", "fairview")):
            continue  # hand-added institutions are finished separately below
        manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
        incidents = _incidents_for(manifest["unitid"], manifest["source_url"], manifest["content_type"])
        (packet_dir / "incidents.json").write_text(json.dumps(incidents, indent=2))
        metadata["model"] = "test-harness"
        metadata["created"] = "2026-02-01T00:00:00Z"
        (packet_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))
        finished += 1
    return finished


def _finish_handadded_packet(tasks_dir: Path, doc_dir: str, incidents_json: dict, created: str) -> None:
    unitid = doc_dir.split("/")[1].split("_", 1)[0]
    hash16 = doc_dir.split("/")[-1]
    packet_dir = tasks_dir / f"{unitid}_{hash16}"
    (packet_dir / "incidents.json").write_text(json.dumps(incidents_json, indent=2))
    metadata = json.loads((packet_dir / "metadata.json").read_text())
    metadata["model"] = "test-harness"
    metadata["created"] = created
    (packet_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))


# ── hand-added archive documents (institutions crawl_pages can't produce) ─────────

def _hand_add_document(archive_run, inst_dir: str, unitid: str, year: int, source_url: str,
                        text: str, pipeline_run_id: str) -> str:
    content = text.encode("utf-8")
    content_hash = sha256_bytes(content)
    hash16 = short_hash(content_hash)
    doc_dir = f"archive/{inst_dir}/{year}/docs/{hash16}"
    fetched_at = _now_iso()

    manifest = {
        "schema_version": 1, "source_url": source_url, "fetched_at": fetched_at,
        "sha256": content_hash, "content_type": "text/html", "size_bytes": len(content),
        "unitid": unitid, "scrape_year": year,
    }
    r2.put_bytes(f"{doc_dir}/manifest.json", json.dumps(manifest, indent=2).encode())
    r2.put_bytes(f"{doc_dir}/original/report.html", content)
    r2.put_bytes(f"{doc_dir}/extracted/text.txt", content)

    status = {
        "schema_version": 1, "unitid": unitid, "scrape_year": year, "status": "published",
        "source_url": source_url, "documents": [content_hash], "fetched_at": fetched_at,
    }
    r2.put_bytes(f"archive/{inst_dir}/{year}/status.json", json.dumps(status, indent=2).encode())

    archive_run.write_ledger_entry("archive", inst_dir, unitid, source_url, text, content_hash)
    archive_run.write_data_check("archive", inst_dir, unitid, year, source_url, "Complete", pipeline_run_id)
    return doc_dir


def _file_hash(doc_dir: str) -> str:
    return hashlib.sha256(r2.get_bytes(f"{doc_dir}/ai/extract_v1/incidents.json")).hexdigest()


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase17_"))
    archive_local_root = tmp_root / "archive_root"
    archive_local_root.mkdir()
    tasks_dir = tmp_root / "tasks_extract"

    prior_env = {k: os.environ.get(k) for k in
                 ["ARCHIVE_LOCAL_ROOT", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID",
                  "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "NEON_DATABASE_URL"]}
    os.environ["ARCHIVE_LOCAL_ROOT"] = str(archive_local_root)
    for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]:
        os.environ.pop(var, None)

    server, thread = _start_server(FIXTURES)
    port = server.server_address[1]
    base_url = f"http://127.0.0.1:{port}"
    schools_csv = tmp_root / "schools.csv"
    template = (FIXTURES / "schools_template.csv").read_text()
    schools_csv.write_text(
        template.replace("{BASE_URL}", base_url)
        + "200006,Hillcrest Academy,ZZ,,confirmed,hand-added fixture (see test_phase17_publish.py)\n"
        + "200007,Ridgeview College,ZZ,,confirmed,hand-added fixture (see test_phase17_publish.py)\n"
        + "200009,Fairview College,ZZ,,confirmed,hand-added fixture (see test_phase17_publish.py)\n"
    )

    db_user = os.environ.get("USER", "postgres")
    db_name = f"hazinginfo_test_{uuid.uuid4().hex[:12]}"
    admin_url = f"postgresql://{db_user}@localhost:5432/postgres"
    test_db_url = f"postgresql://{db_user}@localhost:5432/{db_name}"
    db_created = False

    try:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(f'CREATE DATABASE "{db_name}"')
        db_created = True
        os.environ["NEON_DATABASE_URL"] = test_db_url

        archive_run = _load_module("job_02_archive_run", "jobs/02-archive/run.py")
        normalize_run = _load_module("job_03_normalize_run", "jobs/03-normalize/run.py")
        make_packets = _load_module("job_04_extract_make_packets", "jobs/04-extract/make_packets.py")
        validate = _load_module("job_04_extract_validate", "jobs/04-extract/validate.py")
        ingest = _load_module("job_05_review_ingest", "jobs/05-review/ingest.py")
        rebuild = _load_module("job_06_publish_rebuild", "jobs/06-publish/rebuild.py")

        # ── crawl + normalize the real crawl_pages fixtures ─────────────────
        archive_results = archive_run.run(schools_csv=schools_csv, year=2026)
        if archive_results != {"published": 3, "not_found": 1, "no_url": 1}:
            failures.append(f"setup: unexpected archive results {archive_results!r}")

        norm_results = normalize_run.run(prefix="archive/")
        if norm_results["normalized"] != 5 or norm_results["failed"] != 0:
            failures.append(f"setup: unexpected normalize results {norm_results!r}")

        # ── hand-add hillcrest / ridgeview (x2 years) / fairview ────────────
        handadd_run_id = archive_run.start_pipeline_run()

        hc_dir = _hand_add_document(
            archive_run, "200006_hillcrest-academy", "200006", 2026,
            "http://example.test/hillcrest/chtr-2025.html",
            "Campus Hazing Transparency Report\n"
            "Reporting period: January 1, 2025 - December 31, 2025\n"
            "No hazing incidents were reported during this reporting period.",
            handadd_run_id,
        )
        rv_dir_2026 = _hand_add_document(
            archive_run, "200007_ridgeview-college", "200007", 2026,
            "http://example.test/ridgeview/chtr-2025.html",
            "Campus Hazing Transparency Report -- 2025\n"
            "Ridgeview Rugby Club: hazardous initiation run under investigation.",
            handadd_run_id,
        )
        rv_dir_2027 = _hand_add_document(
            archive_run, "200007_ridgeview-college", "200007", 2027,
            "http://example.test/ridgeview/chtr-2026.html",
            "Campus Hazing Transparency Report -- 2026\n"
            "Ridgeview Rugby Club: investigation concluded, hazing determined.",
            handadd_run_id,
        )
        fv_dir = _hand_add_document(
            archive_run, "200009_fairview-college", "200009", 2026,
            "http://example.test/fairview/chtr-2025.html",
            "Campus Hazing Transparency Report\n"
            "Sigma Alpha Fraternity chapter at Fairview College: hazing finding.",
            handadd_run_id,
        )
        archive_run.complete_pipeline_run(handadd_run_id, "Complete")

        # ── make_packets + validate over the whole archive (crawled + hand-added) ──
        packet_results = make_packets.run(prefix="archive/", tasks_dir=tasks_dir)
        if packet_results != {"packets_created": 9, "skipped": 0, "failed": 0}:
            failures.append(f"make_packets: unexpected results {packet_results!r}")

        finished = _finish_crawled_packets(tasks_dir)
        if finished != 5:
            failures.append(f"expected to finish 5 crawled packets, finished {finished}")

        _finish_handadded_packet(tasks_dir, hc_dir, {
            "schema_version": 2, "is_chtr": True,
            "document": _document("2025-01-01", "2025-12-31", None,
                                   "No hazing incidents were reported during this reporting period."),
            "incidents": [],
        }, "2026-02-01T00:00:00Z")
        _finish_handadded_packet(tasks_dir, rv_dir_2026, {
            "schema_version": 2, "is_chtr": True,
            "document": _document("2025-01-01", "2025-12-31"),
            "incidents": [RV_2026],
        }, "2026-02-01T00:00:00Z")
        _finish_handadded_packet(tasks_dir, rv_dir_2027, {
            "schema_version": 2, "is_chtr": True,
            "document": _document("2026-01-01", "2026-12-31"),
            "incidents": [RV_2027],
        }, "2027-02-01T00:00:00Z")
        _finish_handadded_packet(tasks_dir, fv_dir, {
            "schema_version": 2, "is_chtr": True,
            "document": _document("2025-01-01", "2025-12-31"),
            "incidents": [FV_SIGMA],
        }, "2026-02-01T00:00:00Z")

        validate_results = validate.run(tasks_dir=tasks_dir)
        if validate_results != {"archived": 9, "skipped": 0, "pending": 0, "failed": 0}:
            failures.append(f"validate: unexpected results {validate_results!r}")

        # ── locate doc_dirs for the crawled institutions ────────────────────
        def _status_docs(inst_dir: str, year: int = 2026) -> list[str]:
            status = json.loads((archive_local_root / "archive" / inst_dir / str(year) / "status.json").read_text())
            return [short_hash(h) for h in status["documents"]]

        nr_dir = f"archive/200001_north-ridge-college/2026/docs/{_status_docs('200001_north-ridge-college')[0]}"
        ev_hashes = _status_docs("200002_eastview-university")
        ev_dir = None
        for h in ev_hashes:
            d = f"archive/200002_eastview-university/2026/docs/{h}"
            m = json.loads(r2.get_bytes(f"{d}/manifest.json"))
            if m["content_type"] == "application/pdf" and "decoy" not in m["source_url"]:
                ev_dir = d
        if ev_dir is None:
            failures.append("setup: could not locate eastview's real CHTR PDF doc_dir")
        wf_dir = f"archive/200003_westfield-institute/2026/docs/{_status_docs('200003_westfield-institute')[0]}"

        # ── submit reviews through the real ingest_review() write path ──────
        nr_hash = _file_hash(nr_dir)
        ev_hash = _file_hash(ev_dir)
        wf_hash = _file_hash(wf_dir)
        hc_hash = _file_hash(hc_dir)
        rv26_hash = _file_hash(rv_dir_2026)
        rv27_hash = _file_hash(rv_dir_2027)
        fv_hash = _file_hash(fv_dir)

        def _review(file_hash, index, decision, reviewer, reviewed_at, *,
                    rejection_reason=None, corrections=None, organization_review=None):
            return {
                "schema_version": 2,
                "extraction_ref": {"file_hash": file_hash, "incident_index": index},
                "decision": decision,
                "rejection_reason": rejection_reason,
                "corrections": corrections or [],
                "organization_review": organization_review,
                "reviewer": reviewer,
                "reviewed_at": reviewed_at,
            }

        try:
            ingest.ingest_review(nr_dir, _review(
                nr_hash, 0, "approved", "jane-reviewer", "2026-02-10T18:00:00Z",
                organization_review={"decision": "approved", "corrected_organization_type": None},
            ))
            ingest.ingest_review(nr_dir, _review(
                nr_hash, 1, "rejected", "jane-reviewer", "2026-02-10T18:01:00Z",
                rejection_reason="segmentation_error",
            ))
            ingest.ingest_review(ev_dir, _review(
                ev_hash, 0, "corrected", "jane-reviewer", "2026-02-10T18:02:00Z",
                corrections=[{
                    "field_name": "determination_status", "original_value": "Determined hazing",
                    "corrected_value": "Dismissed", "correction_type": ["Extraction error"],
                }],
            ))
            # westfield's incident is deliberately left with no review.json at all.
            ingest.ingest_review(hc_dir, _review(
                hc_hash, None, "approved", "jane-reviewer", "2026-02-10T18:03:00Z",
            ))
            ingest.ingest_review(rv_dir_2026, _review(
                rv26_hash, 0, "approved", "jane-reviewer", "2026-02-15T09:00:00Z",
                organization_review={"decision": "approved", "corrected_organization_type": None},
            ))
            ingest.ingest_review(rv_dir_2027, _review(
                rv27_hash, 0, "approved", "jane-reviewer", "2027-02-15T09:00:00Z",
                organization_review={"decision": "approved", "corrected_organization_type": None},
            ))
            ingest.ingest_review(fv_dir, _review(
                fv_hash, 0, "approved", "jane-reviewer", "2026-02-20T09:00:00Z",
                organization_review={"decision": "approved", "corrected_organization_type": None},
            ))
        except ingest.IngestError as e:
            failures.append(f"setup: a review was unexpectedly rejected by ingest_review -- {e}")

        # ── rebuild run 1 ────────────────────────────────────────────────────
        results1 = rebuild.run(prefix="archive/", schools_csv=schools_csv)

        expect = {
            "institution": 8, "artifacts": 9, "data_checks": 9,
            "staging_incidents": 7, "staging_organizations": 7, "organizations": 2,
            "incidents": 4, "incident_dates": 7, "incident_organizations": 7,
            "incident_status_history": 1, "possible_matches": 1, "corrections": 1,
            "failed": 0,
        }
        for key, value in expect.items():
            if results1.get(key) != value:
                failures.append(f"rebuild run 1: expected {key}={value}, got {results1.get(key)!r} (full: {results1!r})")

        def _rows(cur, sql, params=()):
            cur.execute(sql, params)
            return cur.fetchall()

        with psycopg.connect(test_db_url) as conn:
            with conn.cursor() as cur:
                # -- rejected incident never reaches public.incidents --
                orgs_in_public = {r[0] for r in _rows(cur, "SELECT organization_name FROM public.organizations")}
                incident_descs = [r[0] for r in _rows(cur, "SELECT incident_description_raw FROM public.incidents")]
                if any("Women's Club Rowing" in d for d in incident_descs):
                    failures.append("rejected incident (Women's Club Rowing) leaked into public.incidents")

                # -- unreviewed incident (westfield) never reaches public.incidents --
                if any("Rho Delta" in d for d in incident_descs):
                    failures.append("unreviewed incident (Rho Delta Chapter) leaked into public.incidents")
                wf_staging = _rows(
                    cur,
                    "SELECT human_review_status FROM staging.staging_incidents WHERE institution_unitid = %s",
                    ("200003",),
                )
                if wf_staging != [("Pending review",)]:
                    failures.append(f"westfield staging_incidents: expected exactly one Pending review row, got {wf_staging!r}")

                # -- corrected review lands in both schemas; incident_id from original raw --
                ev_staging = _rows(
                    cur,
                    "SELECT determination_status FROM staging.staging_incidents WHERE institution_unitid = %s",
                    ("200002",),
                )
                if ev_staging != [("Dismissed",)]:
                    failures.append(f"eastview staging_incidents.determination_status: expected 'Dismissed', got {ev_staging!r}")
                ev_public = _rows(
                    cur,
                    "SELECT incident_id, determination_status FROM public.incidents WHERE institution_unitid = %s",
                    ("200002",),
                )
                if len(ev_public) != 1 or ev_public[0][1] != "Dismissed":
                    failures.append(f"eastview public.incidents: expected one row with 'Dismissed', got {ev_public!r}")
                else:
                    expected_incident_id = rebuild._incident_row_key("200002", EV_ZETA)
                    if ev_public[0][0] != expected_incident_id:
                        failures.append(
                            f"eastview incident_id: expected {expected_incident_id!r} (hash of ORIGINAL raw "
                            f"extraction), got {ev_public[0][0]!r} -- correction must not change the public id"
                        )
                corrections_rows = _rows(
                    cur, "SELECT field_name, original_value, corrected_value FROM staging.staging_incident_corrections"
                )
                if corrections_rows != [("determination_status", "Determined hazing", "Dismissed")]:
                    failures.append(f"staging_incident_corrections: expected exactly the eastview correction, got {corrections_rows!r}")

                # -- flags: mechanically recomputed vs carried-forward-then-cleared --
                def _flags_for(unitid: str) -> set:
                    return set(_rows(
                        cur,
                        "SELECT flag_type, field_name FROM staging.staging_incident_review_flags f "
                        "JOIN staging.staging_incidents si ON f.staging_incident_id = si.staging_incident_id "
                        "WHERE si.institution_unitid = %s",
                        (unitid,),
                    ))

                nr_flags = _flags_for("200001")
                if ("Alcohol/drugs review needed", "alcohol_involved") not in nr_flags:
                    failures.append(f"north-ridge: expected the AI's uncorrected flag to survive, got {nr_flags!r}")

                ev_flags = _flags_for("200002")
                if ("Determination unclear", "determination_status") in ev_flags:
                    failures.append(f"eastview: 'Determination unclear' should have cleared (the reviewer corrected that exact field), got {ev_flags!r}")
                if ("Low extraction confidence", "extraction_confidence") not in ev_flags:
                    failures.append(f"eastview: mechanically-recomputed 'Low extraction confidence' (0.5 < 0.7) missing, got {ev_flags!r}")

                wf_flags = _flags_for("200003")
                if ("Legally required field missing", "findings_raw") not in wf_flags:
                    failures.append(f"westfield: 'Legally required field missing'/findings_raw should be recomputed even with no review, got {wf_flags!r}")

                # -- organization matching: New proposal (north-ridge) + Matched existing (fairview) --
                org_rows = _rows(
                    cur,
                    "SELECT so.match_type, io.organization_id FROM staging.staging_organizations so "
                    "JOIN public.incident_organizations io ON io.staging_organization_id = so.staging_organization_id "
                    "JOIN staging.staging_incidents si ON si.staging_incident_id = io.staging_incident_id "
                    "WHERE si.institution_unitid = %s",
                    ("200001",),
                )
                nr_sigma_org = next((r for r in org_rows if r[1] is not None), None)
                if nr_sigma_org is None or nr_sigma_org[0] != "New proposal":
                    failures.append(f"north-ridge Sigma Alpha organization: expected match_type='New proposal', got {org_rows!r}")

                fv_org_rows = _rows(
                    cur,
                    "SELECT so.match_type, io.organization_id FROM staging.staging_organizations so "
                    "JOIN public.incident_organizations io ON io.staging_organization_id = so.staging_organization_id "
                    "JOIN staging.staging_incidents si ON si.staging_incident_id = io.staging_incident_id "
                    "WHERE si.institution_unitid = %s",
                    ("200009",),
                )
                if len(fv_org_rows) != 1 or fv_org_rows[0][0] != "Matched existing":
                    failures.append(f"fairview organization: expected exactly one 'Matched existing' row, got {fv_org_rows!r}")
                elif nr_sigma_org is not None and fv_org_rows[0][1] != nr_sigma_org[1]:
                    failures.append(
                        f"fairview's organization_id ({fv_org_rows[0][1]!r}) should equal north-ridge's Sigma Alpha "
                        f"organization_id ({nr_sigma_org[1]!r}) -- same comparison key must resolve to the same org"
                    )
                if orgs_in_public != {"Sigma Alpha", "Ridgeview Rugby"}:
                    failures.append(f"public.organizations: expected exactly {{'Sigma Alpha', 'Ridgeview Rugby'}}, got {orgs_in_public!r}")

                # -- hillcrest: zero-incident report stages/promotes nothing (no reports concept in v3.0) --
                hc_staging = _rows(
                    cur, "SELECT staging_incident_id FROM staging.staging_incidents WHERE institution_unitid = %s", ("200006",)
                )
                if hc_staging:
                    failures.append(f"hillcrest: a zero-incident document should stage nothing, got {hc_staging!r}")

                # -- cross-year status update: ridgeview collapses to one incident, updated in place --
                rv_incidents = _rows(
                    cur,
                    "SELECT incident_id, determination_status, staging_incident_id FROM public.incidents WHERE institution_unitid = %s",
                    ("200007",),
                )
                if len(rv_incidents) != 1:
                    failures.append(f"ridgeview: expected exactly 1 public.incidents row (cross-year collapse), got {rv_incidents!r}")
                else:
                    rv_incident_id, rv_status, rv_staging_id = rv_incidents[0]
                    if rv_status != "Determined hazing":
                        failures.append(f"ridgeview: expected final determination_status 'Determined hazing' (year 2027's value), got {rv_status!r}")
                    rv_staging_ordered = _rows(
                        cur,
                        "SELECT staging_incident_id FROM staging.staging_incidents WHERE institution_unitid = %s ORDER BY created_at ASC",
                        ("200007",),
                    )
                    if len(rv_staging_ordered) != 2:
                        failures.append(f"ridgeview: expected 2 staging_incidents rows (one per scrape year), got {rv_staging_ordered!r}")
                    elif rv_staging_id != rv_staging_ordered[0][0]:
                        failures.append(
                            f"ridgeview: incidents.staging_incident_id should stay frozen at year 2026's staging row "
                            f"({rv_staging_ordered[0][0]!r}), got {rv_staging_id!r} instead"
                        )
                    history = _rows(
                        cur,
                        "SELECT old_status, new_status FROM public.incident_status_history WHERE incident_id = %s",
                        (rv_incident_id,),
                    )
                    if history != [("Pending", "Determined hazing")]:
                        failures.append(f"ridgeview incident_status_history: expected exactly one Pending->Determined hazing row, got {history!r}")
                    matches = _rows(
                        cur,
                        "SELECT match_basis FROM staging.staging_incident_possible_matches WHERE existing_incident_id = %s",
                        (rv_incident_id,),
                    )
                    if matches != [("Status update to existing incident",)]:
                        failures.append(f"ridgeview staging_incident_possible_matches: expected one 'Status update to existing incident' row, got {matches!r}")

        # ── rebuild run 2: byte-identical rows (idempotency) ────────────────
        def _full_snapshot():
            with psycopg.connect(test_db_url) as conn:
                with conn.cursor() as cur:
                    tables = {
                        "institution": "SELECT unitid, institution, state_territory, region FROM public.institution ORDER BY unitid",
                        "pipeline_runs": "SELECT * FROM public.pipeline_runs ORDER BY pipeline_run_id",
                        "data_checks": "SELECT * FROM public.data_checks ORDER BY data_check_id",
                        "ledger": "SELECT * FROM public.ledger ORDER BY ledger_id",
                        "artifacts": "SELECT * FROM public.artifacts ORDER BY artifact_id",
                        "staging_incidents": "SELECT * FROM staging.staging_incidents ORDER BY staging_incident_id",
                        "staging_organizations": "SELECT * FROM staging.staging_organizations ORDER BY staging_organization_id",
                        "organizations": "SELECT * FROM public.organizations ORDER BY organization_id",
                        "incidents": "SELECT * FROM public.incidents ORDER BY incident_id",
                        "incident_dates": "SELECT * FROM public.incident_dates ORDER BY incident_date_id",
                        "incident_organizations": "SELECT * FROM public.incident_organizations ORDER BY incident_organization_id",
                        "incident_status_history": "SELECT * FROM public.incident_status_history ORDER BY incident_status_history_id",
                        "possible_matches": "SELECT * FROM staging.staging_incident_possible_matches ORDER BY match_id",
                        "review_flags": "SELECT * FROM staging.staging_incident_review_flags ORDER BY flag_id",
                        "corrections": "SELECT * FROM staging.staging_incident_corrections ORDER BY staging_incident_correction_id",
                    }
                    return {name: _rows(cur, sql) for name, sql in tables.items()}

        snap1 = _full_snapshot()

        results2 = rebuild.run(prefix="archive/", schools_csv=schools_csv)
        if results2 != results1:
            failures.append(f"rebuild run 2: expected identical counts to run 1 {results1!r}, got {results2!r}")

        snap2 = _full_snapshot()
        # institution.created_at is the one documented, accepted exception -- excluded
        # from the snapshot query itself above, so a straight dict compare is enough.
        for name in snap1:
            if snap1[name] != snap2[name]:
                failures.append(f"rebuild run 1 vs run 2: {name} rows differ -- rebuild is not a pure function of the archive")

    finally:
        server.shutdown()
        thread.join(timeout=5)
        shutil.rmtree(tmp_root, ignore_errors=True)
        if db_created:
            try:
                with psycopg.connect(admin_url, autocommit=True) as conn:
                    conn.execute(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                        (db_name,),
                    )
                    conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
            except Exception as e:
                print(f"warning: failed to drop scratch database {db_name}: {e}")
        for k, v in prior_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    if failures:
        print("FAIL")
        for f in failures:
            print(f"      {f}")
        return 1
    print("ok    rebuild run 1: institution/artifacts/data_checks populated from the whole archive")
    print("ok    rejected incident (Women's Club Rowing) never reaches public.incidents")
    print("ok    unreviewed incident (Rho Delta Chapter) never reaches public.incidents")
    print("ok    corrected incident (Zeta Psi): correction lands in both schemas, incident_id frozen at original extraction")
    print("ok    flags: AI-reported flag survives when uncorrected; clears when the reviewer corrects that exact field;")
    print("      mechanically-recomputed flags (Legally required field missing / Low extraction confidence) fire independent of AI flags")
    print("ok    organization matching: north-ridge registers 'New proposal'; fairview matches it as 'Matched existing'")
    print("ok    hillcrest: a zero-incident document-level review stages/promotes nothing (no reports concept in v3.0)")
    print("ok    ridgeview: cross-year 'Status update to existing incident' collapses to one row, staging_incident_id frozen")
    print("ok    rebuild run 2: byte-identical rows across all 15 tables vs run 1 (idempotency)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
