"""Phase 5 smoke check: jobs/06-publish/catalog_schema.sql + rebuild.py.

Builds a real archive the same way test_phase4_extract.py does (crawl + normalize
fixtures/crawl_pages/, make_packets + hand-authored incidents.json standing in for
the agent, then validate.py) so validation.json is genuinely schema-compliant --
reusing the stale, pre-Phase-4-schema fixtures/mini_archive/ was ruled out for
exactly that reason (confirmed with the user).

On top of that archive, hand-writes review.json files covering every path
rebuild.py has to handle:
  - north-ridge incident 0: approved, no corrections -> lands in `incidents` as-is.
  - north-ridge incident 1: rejected -> never enters `incidents`, but the document's
    other approved incident still gives north-ridge a `reports` row.
  - eastview's real CHTR PDF, incident 0: `corrected` with a first-review correction
    to dates.incident_start, AND a second_review that corrects the *same* field to a
    different value -- proves second_review wins per the user's confirmed rule.
  - westfield's incident: validated but deliberately given no review.json at all --
    proves an unreviewed incident never enters the catalog even though it exists in
    the archive.
  - hillcrest (hand-added, genuine zero-incident report, same as test_phase4's "fast"
    tier fixture): a document-level review (extraction_ref.incident_index null,
    Phase 7b) approving the whole document -- proves rebuild.py's new zero-incident
    path writes a `reports` row with is_zero_incident=true and no `incidents` rows.

Runs rebuild.py twice against a scratch local Postgres database (created via the
already-running local `postgres` server -- see BUILD_STATUS.md) and asserts every
row and every ID is identical both times (invariant 9), and that exactly the
approved/corrected incidents above -- and no others -- ended up in `incidents`.

Run with: .venv/bin/python tests/test_phase5_publish.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import uuid
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


_QUOTE = lambda text, page=None: {"text": text, "page": page}  # noqa: E731
_NULL_DATES = {
    "incident_quote": None,
    "incident_start": None,
    "incident_end": None,
    "investigation_initiated": None,
    "resolved": None,
}
_EMPTY_DOCUMENT = {
    "title_quote": None,
    "reporting_period_quote": None,
    "reporting_period_start": None,
    "reporting_period_end": None,
    "publication_date": None,
    "zero_incidents_quote": None,
}


def _incidents_for(manifest: dict) -> dict:
    unitid = manifest["unitid"]
    source_url = manifest["source_url"]
    content_type = manifest["content_type"]

    if unitid == "200001":  # north-ridge: two incidents (one approved, one rejected later)
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                **_EMPTY_DOCUMENT,
                "title_quote": _QUOTE("Campus Hazing Transparency Report"),
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
            },
            "incidents": [
                {
                    "organization_quote": _QUOTE("Sigma Alpha Fraternity"),
                    "description_quote": _QUOTE(
                        "new members of Sigma Alpha Fraternity were required to "
                        "perform physically demanding tasks late at night as part "
                        "of an unofficial initiation ritual."
                    ),
                    "findings_quote": _QUOTE("The organization was found responsible for hazing."),
                    "sanction_quotes": [_QUOTE("Sanction: probation through Fall 2026.")],
                    "alcohol_involved": False,
                    "drugs_involved": False,
                    "dates": {**_NULL_DATES, "incident_quote": _QUOTE("September 2025"), "incident_start": "2025-09-01"},
                },
                {
                    "organization_quote": _QUOTE("Women's Club Rowing"),
                    "description_quote": _QUOTE(
                        "members of the Women's Club Rowing team required new "
                        "members to consume alcohol at a team event."
                    ),
                    "findings_quote": _QUOTE("The organization was found responsible for hazing."),
                    "sanction_quotes": [_QUOTE("Sanction: loss of club-sport funding for one year.")],
                    "alcohol_involved": True,
                    "drugs_involved": None,
                    "dates": {**_NULL_DATES, "incident_quote": _QUOTE("October 2025")},
                },
            ],
        }

    if unitid == "200002" and content_type == "application/pdf" and "decoy" not in source_url:
        return {  # eastview's real CHTR PDF -- one incident, corrected twice below
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                **_EMPTY_DOCUMENT,
                "title_quote": _QUOTE("Campus Hazing Transparency Report", 1),
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
            },
            "incidents": [
                {
                    "organization_quote": _QUOTE("Zeta Psi Fraternity", 1),
                    "description_quote": _QUOTE(
                        "During Fall 2025 recruitment, new members were required to "
                        "consume alcohol during a pledge event.",
                        1,
                    ),
                    "findings_quote": _QUOTE("The organization was investigated and found responsible for hazing.", 1),
                    "sanction_quotes": [_QUOTE("Sanction: suspension through Spring 2027.", 1)],
                    "alcohol_involved": True,
                    "drugs_involved": None,
                    "dates": {**_NULL_DATES, "incident_quote": _QUOTE("Fall 2025", 1)},
                }
            ],
        }

    if unitid == "200002":  # eastview's decoy PDF / index page -- not a CHTR
        return {"schema_version": 1, "is_chtr": False, "document": dict(_EMPTY_DOCUMENT), "incidents": []}

    if unitid == "200006":  # hillcrest (hand-added): genuine zero-incident report
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                **_EMPTY_DOCUMENT,
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "zero_incidents_quote": _QUOTE("No hazing incidents were reported during this reporting period."),
            },
            "incidents": [],
        }

    if unitid == "200003":  # westfield: one incident, deliberately never reviewed
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": dict(_EMPTY_DOCUMENT),
            "incidents": [
                {
                    "organization_quote": _QUOTE("Rho Delta Chapter", 1),
                    "description_quote": _QUOTE("Unable to confirm text against a scanned page image.", 1),
                    "findings_quote": None,
                    "sanction_quotes": [],
                    "alcohol_involved": None,
                    "drugs_involved": None,
                    "dates": dict(_NULL_DATES),
                }
            ],
        }

    raise AssertionError(f"no fixture incidents.json defined for unitid {unitid!r} / {source_url!r}")


def _finish_packets(tasks_dir: Path) -> int:
    finished = 0
    for packet_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        metadata = json.loads((packet_dir / "metadata.json").read_text())
        doc_dir = metadata["doc_dir"]
        manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))

        incidents = _incidents_for(manifest)
        (packet_dir / "incidents.json").write_text(json.dumps(incidents, indent=2))

        metadata["model"] = "test-harness"
        metadata["created"] = "2026-02-01T00:00:00Z"
        (packet_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))
        finished += 1
    return finished


def _add_hillcrest(archive_root: Path) -> str:
    """Hand-adds a genuine zero-incident report directly to the archive -- same
    fixture test_phase4_extract.py builds for the "fast" tier case. Returns its
    doc_dir key (relative to the archive local root)."""
    text = (
        "Campus Hazing Transparency Report\n"
        "Reporting period: January 1, 2025 - December 31, 2025\n"
        "No hazing incidents were reported during this reporting period."
    )
    content = text.encode("utf-8")
    content_hash = sha256_bytes(content)
    hash16 = short_hash(content_hash)
    doc_dir = f"archive/200006_hillcrest-academy/2026/docs/{hash16}"

    manifest = {
        "schema_version": 1,
        "source_url": "http://example.test/hillcrest/chtr-2025.html",
        "fetched_at": "2026-01-20T00:00:00Z",
        "sha256": content_hash,
        "content_type": "text/html",
        "size_bytes": len(content),
        "unitid": "200006",
        "scrape_year": 2026,
    }
    r2.put_bytes(f"{doc_dir}/manifest.json", json.dumps(manifest).encode("utf-8"))
    r2.put_bytes(f"{doc_dir}/original/report.html", content)
    r2.put_bytes(f"{doc_dir}/extracted/text.txt", content)

    status = {
        "schema_version": 1,
        "unitid": "200006",
        "scrape_year": 2026,
        "status": "published",
        "source_url": manifest["source_url"],
        "documents": [content_hash],
        "fetched_at": manifest["fetched_at"],
    }
    r2.put_bytes("archive/200006_hillcrest-academy/2026/status.json", json.dumps(status).encode("utf-8"))
    return doc_dir


def _hash16_for(archive_local_root: Path, inst_dir: str, *, predicate=None) -> str:
    status = json.loads((archive_local_root / "archive" / inst_dir / "2026" / "status.json").read_text())
    hashes = status["documents"]
    if predicate is None:
        return short_hash(hashes[0])
    for h in hashes:
        hash16 = short_hash(h)
        manifest = json.loads(r2.get_bytes(f"archive/{inst_dir}/2026/docs/{hash16}/manifest.json"))
        if predicate(manifest):
            return hash16
    raise AssertionError(f"no document under {inst_dir} matched predicate")


def _write_review(doc_dir: str, index: int, filename: str, review: dict) -> None:
    r2.put_bytes(f"{doc_dir}/reviews/{filename}", json.dumps(review, indent=2).encode("utf-8"))


def _file_hash(doc_dir: str) -> str:
    import hashlib
    return hashlib.sha256(r2.get_bytes(f"{doc_dir}/ai/extract_v1/incidents.json")).hexdigest()


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase5_"))
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
        + "200006,Hillcrest Academy,ZZ,,confirmed,hand-added fixture (see test_phase4_extract.py)\n"
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
        rebuild = _load_module("job_06_publish_rebuild", "jobs/06-publish/rebuild.py")

        archive_results = archive_run.run(schools_csv=schools_csv, year=2026)
        if archive_results != {"published": 3, "not_found": 1, "no_url": 1}:
            failures.append(f"setup: unexpected archive results {archive_results!r}")

        norm_results = normalize_run.run(prefix="archive/")
        if norm_results["normalized"] != 5 or norm_results["failed"] != 0:
            failures.append(f"setup: unexpected normalize results {norm_results!r}")

        hc_dir = _add_hillcrest(archive_local_root)

        packet_results = make_packets.run(prefix="archive/", tasks_dir=tasks_dir)
        if packet_results != {"packets_created": 6, "skipped": 0, "failed": 0}:
            failures.append(f"setup: unexpected make_packets results {packet_results!r}")

        finished = _finish_packets(tasks_dir)
        if finished != 6:
            failures.append(f"setup: expected to finish 6 packets, finished {finished}")

        validate_results = validate.run(tasks_dir=tasks_dir)
        if validate_results != {"archived": 6, "skipped": 0, "pending": 0, "failed": 0}:
            failures.append(f"setup: unexpected validate results {validate_results!r}")

        nr_dir = f"archive/200001_north-ridge-college/2026/docs/{_hash16_for(archive_local_root, '200001_north-ridge-college')}"
        ev_dir = f"archive/200002_eastview-university/2026/docs/{_hash16_for(archive_local_root, '200002_eastview-university', predicate=lambda m: m['content_type'] == 'application/pdf' and 'decoy' not in m['source_url'])}"
        wf_dir = f"archive/200003_westfield-institute/2026/docs/{_hash16_for(archive_local_root, '200003_westfield-institute')}"

        nr_hash = _file_hash(nr_dir)
        ev_hash = _file_hash(ev_dir)
        hc_hash = _file_hash(hc_dir)

        _write_review(nr_dir, 0, "0_jane-reviewer_20260210T180000Z.review.json", {
            "schema_version": 1,
            "extraction_ref": {"file_hash": nr_hash, "incident_index": 0},
            "tier": "flagged",
            "decision": "approved",
            "rejection_reason": None,
            "corrections": None,
            "reviewer": "jane-reviewer",
            "reviewed_at": "2026-02-10T18:00:00Z",
            "second_review": None,
        })
        _write_review(nr_dir, 1, "1_jane-reviewer_20260210T180100Z.review.json", {
            "schema_version": 1,
            "extraction_ref": {"file_hash": nr_hash, "incident_index": 1},
            "tier": "flagged",
            "decision": "rejected",
            "rejection_reason": "segmentation_error",
            "corrections": None,
            "reviewer": "jane-reviewer",
            "reviewed_at": "2026-02-10T18:01:00Z",
            "second_review": None,
        })
        _write_review(ev_dir, 0, "0_jane-reviewer_20260210T180200Z.review.json", {
            "schema_version": 1,
            "extraction_ref": {"file_hash": ev_hash, "incident_index": 0},
            "tier": "flagged",
            "decision": "corrected",
            "rejection_reason": None,
            "corrections": {"dates.incident_start": "2025-09-15"},
            "reviewer": "jane-reviewer",
            "reviewed_at": "2026-02-10T18:02:00Z",
            "second_review": {
                "decision": "corrected",
                "rejection_reason": None,
                "corrections": {"dates.incident_start": "2025-09-20"},
                "reviewer": "john-reviewer",
                "reviewed_at": "2026-02-11T09:00:00Z",
            },
        })
        # westfield's incident is deliberately left with no review.json.

        _write_review(hc_dir, 0, "document_jane-reviewer_20260210T180300Z.review.json", {
            "schema_version": 1,
            "extraction_ref": {"file_hash": hc_hash, "incident_index": None},
            "tier": "fast",
            "decision": "approved",
            "rejection_reason": None,
            "corrections": None,
            "reviewer": "jane-reviewer",
            "reviewed_at": "2026-02-10T18:03:00Z",
            "second_review": None,
        })

        results1 = rebuild.run(prefix="archive/", schools_csv=schools_csv)
        expected_counts = {
            "institutions": 6, "reporting_status": 6, "documents": 6,
            "reports": 3, "incidents": 2, "incident_sanctions": 2, "failed": 0,
        }
        if results1 != expected_counts:
            failures.append(f"rebuild run 1: expected {expected_counts!r}, got {results1!r}")

        def _snapshot():
            with psycopg.connect(test_db_url) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT unitid, name, state FROM institutions ORDER BY unitid")
                    institutions = cur.fetchall()
                    cur.execute("SELECT content_hash, unitid, has_text_layer FROM documents ORDER BY content_hash")
                    documents = cur.fetchall()
                    cur.execute("SELECT unitid, scrape_year, status FROM reporting_status ORDER BY unitid")
                    statuses = cur.fetchall()
                    cur.execute(
                        "SELECT incident_id, report_id, organization_text, alcohol_involved, drugs_involved, "
                        "incident_start, reviewer, second_reviewer FROM incidents ORDER BY organization_text"
                    )
                    incidents = cur.fetchall()
                    cur.execute("SELECT incident_id, sanction_text FROM incident_sanctions ORDER BY incident_id, sanction_text")
                    sanctions = cur.fetchall()
                    cur.execute("SELECT report_id, is_zero_incident FROM reports ORDER BY report_id")
                    reports = cur.fetchall()
            return institutions, documents, statuses, incidents, sanctions, reports

        snap1 = _snapshot()
        institutions1, documents1, statuses1, incidents1, sanctions1, reports1 = snap1

        if len(institutions1) != 6:
            failures.append(f"institutions: expected 6 rows, got {len(institutions1)}")
        if len(documents1) != 6:
            failures.append(f"documents: expected 6 rows, got {len(documents1)}")
        if len(statuses1) != 6:
            failures.append(f"reporting_status: expected 6 rows, got {len(statuses1)}")

        wf_hash = json.loads(r2.get_bytes(f"{wf_dir}/manifest.json"))["sha256"]
        wf_doc = next((d for d in documents1 if d[0] == wf_hash), None)
        if wf_doc is None or wf_doc[2] is not False:
            failures.append(f"documents: expected westfield's scanned doc to have has_text_layer=false, got {wf_doc!r}")

        if len(incidents1) != 2:
            failures.append(f"incidents: expected 2 rows (approved + corrected only), got {len(incidents1)}")
        orgs = {row[2] for row in incidents1}
        if orgs != {"Sigma Alpha Fraternity", "Zeta Psi Fraternity"}:
            failures.append(f"incidents: expected Sigma Alpha + Zeta Psi only (rejected/unreviewed excluded), got {orgs!r}")

        zeta = next((row for row in incidents1 if row[2] == "Zeta Psi Fraternity"), None)
        if zeta is None:
            failures.append("incidents: Zeta Psi Fraternity row missing")
        else:
            incident_id, report_id, _org, alcohol, drugs, incident_start, reviewer, second_reviewer = zeta
            if str(incident_start) != "2025-09-20":
                failures.append(f"incidents: expected second_review's correction (2025-09-20) to win, got {incident_start!r}")
            if reviewer != "jane-reviewer" or second_reviewer != "john-reviewer":
                failures.append(f"incidents: expected reviewer=jane-reviewer/second_reviewer=john-reviewer, got {reviewer!r}/{second_reviewer!r}")

        sigma = next((row for row in incidents1 if row[2] == "Sigma Alpha Fraternity"), None)
        if sigma is None:
            failures.append("incidents: Sigma Alpha Fraternity row missing")
        elif sigma[7] is not None:
            failures.append(f"incidents: Sigma Alpha has no second_review, expected second_reviewer=NULL, got {sigma[7]!r}")

        if len(sanctions1) != 2:
            failures.append(f"incident_sanctions: expected 2 rows, got {len(sanctions1)}")
        if len(reports1) != 3:
            failures.append(f"reports: expected 3 rows (north-ridge + eastview + hillcrest), got {len(reports1)}")
        zero_incident_reports = [r for r, is_zero in reports1 if is_zero]
        if len(zero_incident_reports) != 1:
            failures.append(
                f"reports: expected exactly 1 is_zero_incident=true row (hillcrest's approved "
                f"document-level review), got {reports1!r}"
            )

        # ── rebuild run 2: byte-identical ids, identical rows (invariant 9) ──
        results2 = rebuild.run(prefix="archive/", schools_csv=schools_csv)
        if results2 != expected_counts:
            failures.append(f"rebuild run 2: expected {expected_counts!r}, got {results2!r}")

        snap2 = _snapshot()
        if snap1 != snap2:
            failures.append("rebuild run 1 vs run 2: catalog rows differ -- rebuild is not a pure function of the archive")

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
    print("ok    rebuild run 1: institutions/documents/reporting_status populated from the whole archive")
    print("ok    approved incident (Sigma Alpha) lands in incidents unchanged")
    print("ok    rejected incident (Women's Club Rowing) never enters incidents")
    print("ok    unreviewed incident (westfield) never enters incidents")
    print("ok    corrected incident (Zeta Psi): second_review's correction wins over the first review's")
    print("ok    hillcrest: approved document-level review produces an is_zero_incident=true reports row, no incidents")
    print("ok    rebuild run 2: byte-identical ids and rows vs run 1 (invariant 9)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
