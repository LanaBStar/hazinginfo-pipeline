"""Phase 4 / Phase 14 smoke check: jobs/04-extract/make_packets.py + validate.py (v3.0).

Builds a real archive by crawling and normalizing fixtures/crawl_pages/ (same pattern
as test_phase2_archive.py / test_phase3_normalize.py), then hand-adds one more document
directly to the archive -- a genuine zero-incident report -- since crawl_pages has no
such fixture and adding one there would change the exact document counts
test_phase2_archive.py / test_phase3_normalize.py assert on. This document skips 02/03
(it's created already-normalized) but is otherwise a normal archived document as far as
04-extract is concerned.

Runs make_packets.py over the resulting archive, hand-writes an incidents.json (v2
shape -- raw+normalized fields, extraction_confidence, flags[], organization proposal,
determination_status; no more page-anchored quotes) into each packet (standing in for
the agent), then runs validate.py and asserts: schema-valid documents archive with
valid:true and their confidence/flags/organization fields intact; a deliberately
schema-invalid document (an unknown flag_type) still archives, marked valid:false, with
its schema_errors recorded -- never silently discarded. Also checks both make_packets.py
and validate.py are idempotent on a second run.

There is no tier assignment or anchoring here -- validation.json is just
{schema_version, valid, schema_errors}; see validate.py's module docstring for why.

Run with: python tests/test_phase4_extract.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

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


def _add_hillcrest(archive_root: Path) -> str:
    """Hand-adds a genuine zero-incident report directly to the archive."""
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


_NULL_DATES = {
    "incident_start_raw": "", "incident_start_normalized": None, "incident_start_precision": "Unknown",
    "incident_end_raw": "", "incident_end_normalized": None, "incident_end_precision": "Unknown",
    "investigation_start_date_raw": "", "investigation_start_date": None,
    "investigation_end_date_raw": "", "investigation_end_date": None,
    "notice_date_raw": "", "notice_date": None,
}


def _incident(organization_name_raw, organization_name_normalized, organization_type,
              description_raw, findings_raw, sanctions_raw, alcohol_involved, drugs_involved,
              determination_status, dates, extraction_confidence, flags):
    return {
        "organization_name_raw": organization_name_raw,
        "organization_name_normalized": organization_name_normalized,
        "organization_type": organization_type,
        "description_raw": description_raw,
        "findings_raw": findings_raw,
        "sanctions_raw": sanctions_raw,
        "alcohol_involved": alcohol_involved,
        "drugs_involved": drugs_involved,
        "determination_status": determination_status,
        "dates": {**_NULL_DATES, **dates},
        "extraction_confidence": extraction_confidence,
        "flags": flags,
    }


def _incidents_for(doc_dir: str, manifest: dict) -> dict:
    unitid = manifest["unitid"]
    source_url = manifest["source_url"]
    content_type = manifest["content_type"]

    if unitid == "200001":  # north-ridge: two clean incidents
        return {
            "schema_version": 2,
            "is_chtr": True,
            "document": {
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "publication_date": None,
                "zero_incidents_statement": None,
            },
            "incidents": [
                _incident(
                    "Sigma Alpha Fraternity", "Sigma Alpha", "Fraternity",
                    "new members of Sigma Alpha Fraternity were required to perform "
                    "physically demanding tasks late at night as part of an unofficial "
                    "initiation ritual.",
                    "The organization was investigated and found responsible for hazing.",
                    "Sanction: probation through Fall 2026.",
                    "No", "No", "Determined hazing",
                    {"incident_start_raw": "September 2025", "incident_start_normalized": "2025-09-01",
                     "incident_start_precision": "Month"},
                    0.95, [],
                ),
                _incident(
                    "Women's Club Rowing", "Women's Club Rowing", "Club Sport",
                    "members of the Women's Club Rowing team required new members to "
                    "consume alcohol at a team event.",
                    "The organization was found responsible for hazing.",
                    "Sanction: loss of club-sport funding for one year.",
                    "Yes", "Not specified", "Determined hazing",
                    {"incident_start_raw": "October 2025"},
                    0.88, [],
                ),
            ],
        }

    if unitid == "200002" and content_type == "application/pdf" and "decoy" not in source_url:
        # eastview's real CHTR PDF -- one incident, sanction wording mentions suspension
        # (no special flag_type for this in v3.0's vocab -- just stored content now).
        return {
            "schema_version": 2,
            "is_chtr": True,
            "document": {
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "publication_date": None,
                "zero_incidents_statement": None,
            },
            "incidents": [
                _incident(
                    "Zeta Psi Fraternity", "Zeta Psi", "Fraternity",
                    "During Fall 2025 recruitment, new members were required to consume "
                    "alcohol during a pledge event.",
                    "The organization was investigated and found responsible for hazing.",
                    "Sanction: suspension through Spring 2027.",
                    "Yes", "Not specified", "Determined hazing",
                    {"incident_start_raw": "Fall 2025", "incident_start_precision": "Academic term"},
                    0.5, [{"flag_type": "Low extraction confidence", "field_name": "extraction_confidence",
                           "note": "Sanction wording is terse; moderate confidence in segmentation."}],
                )
            ],
        }

    if unitid == "200002":
        # eastview's decoy menu PDF, or its own index/listing page -- neither is a CHTR.
        # The decoy PDF is the deliberately-invalid case: an unknown flag_type value,
        # which schema.json must reject (exercises "invalid output archived too").
        is_decoy = "decoy" in source_url
        doc = {
            "schema_version": 2,
            "is_chtr": False,
            "document": {
                "reporting_period_start": None,
                "reporting_period_end": None,
                "publication_date": None,
                "zero_incidents_statement": None,
            },
            "incidents": [],
        }
        if is_decoy:
            doc["unexpected_top_level_field"] = "this violates additionalProperties: false"
        return doc

    if unitid == "200003":  # westfield: scanned, nothing readable
        return {
            "schema_version": 2,
            "is_chtr": True,
            "document": {
                "reporting_period_start": None,
                "reporting_period_end": None,
                "publication_date": None,
                "zero_incidents_statement": None,
            },
            "incidents": [],
        }

    if unitid == "200006":  # hillcrest: genuine zero-incident report
        return {
            "schema_version": 2,
            "is_chtr": True,
            "document": {
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "publication_date": None,
                "zero_incidents_statement": "No hazing incidents were reported during this reporting period.",
            },
            "incidents": [],
        }

    raise AssertionError(f"no fixture incidents.json defined for unitid {unitid!r} / {source_url!r}")


def _finish_packets(tasks_dir: Path) -> int:
    """Stands in for the agent: writes incidents.json and fills in metadata.json's
    model/created for every packet. Returns the number of packets finished."""
    finished = 0
    for packet_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        metadata = json.loads((packet_dir / "metadata.json").read_text())
        doc_dir = metadata["doc_dir"]
        manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))

        incidents = _incidents_for(doc_dir, manifest)
        (packet_dir / "incidents.json").write_text(json.dumps(incidents, indent=2))

        metadata["model"] = "test-harness"
        metadata["created"] = "2026-02-01T00:00:00Z"
        (packet_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))
        finished += 1
    return finished


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase4_"))
    archive_local_root = tmp_root / "archive_root"
    archive_local_root.mkdir()
    tasks_dir = tmp_root / "tasks_extract"

    prior_env = {k: os.environ.get(k) for k in
                 ["ARCHIVE_LOCAL_ROOT", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID",
                  "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]}
    os.environ["ARCHIVE_LOCAL_ROOT"] = str(archive_local_root)
    for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]:
        os.environ.pop(var, None)

    server, thread = _start_server(FIXTURES)
    port = server.server_address[1]
    base_url = f"http://127.0.0.1:{port}"
    schools_csv = tmp_root / "schools.csv"
    template = (FIXTURES / "schools_template.csv").read_text()
    schools_csv.write_text(template.replace("{BASE_URL}", base_url))

    try:
        archive_run = _load_module("job_02_archive_run", "jobs/02-archive/run.py")
        normalize_run = _load_module("job_03_normalize_run", "jobs/03-normalize/run.py")
        make_packets = _load_module("job_04_extract_make_packets", "jobs/04-extract/make_packets.py")
        validate = _load_module("job_04_extract_validate", "jobs/04-extract/validate.py")

        archive_results = archive_run.run(schools_csv=schools_csv, year=2026)
        if archive_results != {"published": 3, "not_found": 1, "no_url": 1}:
            failures.append(f"setup: unexpected archive results {archive_results!r}")

        norm_results = normalize_run.run(prefix="archive/")
        if norm_results["normalized"] != 5 or norm_results["failed"] != 0:
            failures.append(f"setup: unexpected normalize results {norm_results!r}")

        _add_hillcrest(archive_local_root)

        # ── make_packets run 1 ──────────────────────────────────────────
        packet_results = make_packets.run(prefix="archive/", tasks_dir=tasks_dir)
        if packet_results != {"packets_created": 6, "skipped": 0, "failed": 0}:
            failures.append(f"make_packets run 1: unexpected results {packet_results!r}")

        finished = _finish_packets(tasks_dir)
        if finished != 6:
            failures.append(f"expected to finish 6 packets, finished {finished}")

        # ── validate run 1 ───────────────────────────────────────────────
        validate_results = validate.run(tasks_dir=tasks_dir)
        # 5 valid documents archive clean; eastview's decoy PDF is deliberately invalid
        # but still archives (marked invalid, never discarded) -- "failed" only counts a
        # script-level exception, which this isn't.
        if validate_results != {"archived": 6, "skipped": 0, "pending": 0, "failed": 0}:
            failures.append(f"validate run 1: unexpected results {validate_results!r}")

        def _extract_v1_dir(inst_dir: str, hash16: str) -> Path:
            return archive_local_root / "archive" / inst_dir / "2026" / "docs" / hash16 / "ai" / "extract_v1"

        def _validation_for(inst_dir: str, hash16: str) -> dict:
            return json.loads((_extract_v1_dir(inst_dir, hash16) / "validation.json").read_text())

        def _incidents_json_for(inst_dir: str, hash16: str) -> dict:
            return json.loads((_extract_v1_dir(inst_dir, hash16) / "incidents.json").read_text())

        def _hash16_for(inst_dir: str) -> str:
            status = json.loads((archive_local_root / "archive" / inst_dir / "2026" / "status.json").read_text())
            return short_hash(status["documents"][0])

        # north-ridge: both incidents valid, carry organization proposal + confidence + no flags
        nr_hash = _hash16_for("200001_north-ridge-college")
        nr_validation = _validation_for("200001_north-ridge-college", nr_hash)
        nr_incidents = _incidents_json_for("200001_north-ridge-college", nr_hash)
        if not nr_validation["valid"] or nr_validation["schema_errors"]:
            failures.append(f"north-ridge: expected valid incidents.json, got {nr_validation!r}")
        if "tier" in nr_validation or "document" in nr_validation:
            failures.append(f"north-ridge validation.json: v3.0 has no tier/document/quotes fields, got {nr_validation!r}")
        incidents = nr_incidents["incidents"]
        if len(incidents) != 2 or any(inc["flags"] for inc in incidents):
            failures.append(f"north-ridge: expected 2 incidents with no flags, got {incidents!r}")
        if incidents[0]["organization_type"] != "Fraternity" or incidents[1]["organization_type"] != "Club Sport":
            failures.append(f"north-ridge: organization_type mismatch: {[i['organization_type'] for i in incidents]!r}")
        if not all(isinstance(inc["extraction_confidence"], float) for inc in incidents):
            failures.append(f"north-ridge: expected float extraction_confidence, got {[i['extraction_confidence'] for i in incidents]!r}")

        # eastview: 3 documents (index page, real CHTR PDF, decoy PDF)
        ev_status = json.loads((archive_local_root / "archive" / "200002_eastview-university" / "2026" / "status.json").read_text())
        ev_hashes = [short_hash(h) for h in ev_status["documents"]]
        ev_validations = {h: _validation_for("200002_eastview-university", h) for h in ev_hashes}

        invalid = [v for v in ev_validations.values() if not v["valid"]]
        if len(invalid) != 1:
            failures.append(f"eastview: expected exactly 1 invalid document (the decoy), got {len(invalid)}")
        elif not invalid[0]["schema_errors"]:
            failures.append("eastview: invalid document should have non-empty schema_errors")
        elif "unexpected_top_level_field" not in invalid[0]["schema_errors"][0]:
            failures.append(f"eastview: expected schema_errors to mention the offending field, got {invalid[0]['schema_errors']!r}")

        valid_docs = {h: v for h, v in ev_validations.items() if v["valid"]}
        if len(valid_docs) != 2:
            failures.append(f"eastview: expected exactly 2 valid documents, got {len(valid_docs)}")
        chtr_hash = next((h for h in valid_docs if _incidents_json_for("200002_eastview-university", h)["incidents"]), None)
        if chtr_hash is None:
            failures.append("eastview: expected exactly one valid document with a non-empty incidents array")
        else:
            chtr_incident = _incidents_json_for("200002_eastview-university", chtr_hash)["incidents"][0]
            if "suspension" not in chtr_incident["sanctions_raw"]:
                failures.append(f"eastview CHTR PDF: expected suspension wording in sanctions_raw, got {chtr_incident['sanctions_raw']!r}")
            if not chtr_incident["flags"]:
                failures.append("eastview CHTR PDF: expected the hand-authored low-confidence flag to survive schema validation")

        # westfield: scanned/nothing-readable zero-incident document -- still schema-valid
        wf_hash = _hash16_for("200003_westfield-institute")
        wf_validation = _validation_for("200003_westfield-institute", wf_hash)
        wf_incidents = _incidents_json_for("200003_westfield-institute", wf_hash)
        if not wf_validation["valid"]:
            failures.append(f"westfield: expected valid incidents.json even with nothing readable, got {wf_validation!r}")
        if wf_incidents["incidents"] != [] or wf_incidents["document"]["zero_incidents_statement"] is not None:
            failures.append(f"westfield: expected zero incidents and null zero_incidents_statement, got {wf_incidents!r}")

        # hillcrest: genuine zero-incident report
        hc_hash = _hash16_for("200006_hillcrest-academy")
        hc_validation = _validation_for("200006_hillcrest-academy", hc_hash)
        hc_incidents = _incidents_json_for("200006_hillcrest-academy", hc_hash)
        if not hc_validation["valid"]:
            failures.append(f"hillcrest: expected valid incidents.json, got {hc_validation!r}")
        if hc_incidents["document"]["zero_incidents_statement"] is None:
            failures.append("hillcrest: expected a non-null zero_incidents_statement")

        # ── idempotency: second runs write nothing new ──────────────────
        packet_results2 = make_packets.run(prefix="archive/", tasks_dir=tasks_dir)
        if packet_results2 != {"packets_created": 0, "skipped": 6, "failed": 0}:
            failures.append(f"make_packets run 2 (idempotency): expected all skipped, got {packet_results2!r}")

        validate_results2 = validate.run(tasks_dir=tasks_dir)
        if validate_results2 != {"archived": 0, "skipped": 6, "pending": 0, "failed": 0}:
            failures.append(f"validate run 2 (idempotency): expected all skipped, got {validate_results2!r}")

    finally:
        server.shutdown()
        thread.join(timeout=5)
        shutil.rmtree(tmp_root, ignore_errors=True)
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
    print("ok    make_packets run 1: one packet per normalized document (6), all fields present")
    print("ok    validate run 1: schema validation only (no tier/anchoring in v3.0)")
    print("ok    north-ridge: 2 valid incidents with organization proposal + confidence, no flags")
    print("ok    eastview: real CHTR PDF valid with a flag; decoy PDF invalid (archived anyway); index page non-CHTR")
    print("ok    westfield: scanned/nothing-readable document still schema-valid, zero incidents")
    print("ok    hillcrest: genuine zero-incident report schema-valid with a real zero_incidents_statement")
    print("ok    make_packets / validate run 2: idempotent, nothing re-written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
