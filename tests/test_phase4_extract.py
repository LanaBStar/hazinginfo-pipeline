"""Phase 4 smoke check: jobs/04-extract/make_packets.py + validate.py.

Builds a real archive by crawling and normalizing fixtures/crawl_pages/ (same pattern
as test_phase2_archive.py / test_phase3_normalize.py), then hand-adds one more document
directly to the archive -- a genuine zero-incident report with anchorable text -- since
crawl_pages has no such fixture and adding one there would change the exact document
counts test_phase2_archive.py / test_phase3_normalize.py assert on. This document skips
02/03 (it's created already-normalized) but is otherwise a normal archived document as
far as 04-extract is concerned.

Runs make_packets.py over the resulting archive, hand-writes an incidents.json into
each packet (standing in for the agent) covering: two clean incidents (north-ridge),
one incident with a suspension sanction (eastview's real CHTR PDF), a non-CHTR PDF and
a non-CHTR index page (both eastview), a zero-incident report with unanchorable text
because its text.txt is empty (westfield, scanned), and a zero-incident report with
anchorable text (the hand-added document) -- then runs validate.py and asserts the
resulting validation.json for each lands on the expected tier, including one flagged
case and one fast case per the plan's smoke-check requirement. Also checks both
make_packets.py and validate.py are idempotent on a second run.

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
    """Hand-adds a genuine zero-incident report directly to the archive -- the "fast"
    tier fixture. Returns its doc_dir key (relative to the archive local root)."""
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


_QUOTE = lambda text, page=None: {"text": text, "page": page}  # noqa: E731
_NULL_DATES = {
    "incident_quote": None,
    "incident_start": None,
    "incident_end": None,
    "investigation_initiated": None,
    "resolved": None,
}


def _incidents_for(doc_dir: str, manifest: dict) -> dict:
    unitid = manifest["unitid"]
    source_url = manifest["source_url"]
    content_type = manifest["content_type"]

    if unitid == "200001":  # north-ridge: two clean incidents
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                "title_quote": _QUOTE("Campus Hazing Transparency Report"),
                "reporting_period_quote": _QUOTE("Reporting period: January 1, 2025 - December 31, 2025"),
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "publication_date": None,
                "zero_incidents_quote": None,
            },
            "incidents": [
                {
                    "organization_quote": _QUOTE("Sigma Alpha Fraternity"),
                    "description_quote": _QUOTE(
                        "new members of Sigma Alpha Fraternity were required to "
                        "perform physically demanding tasks late at night as part "
                        "of an unofficial initiation ritual."
                    ),
                    "findings_quote": _QUOTE(
                        "The organization was investigated and found responsible for hazing."
                    ),
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
        # eastview's real CHTR PDF -- one incident, sanction wording triggers flagged.
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                "title_quote": _QUOTE("Campus Hazing Transparency Report", 1),
                "reporting_period_quote": _QUOTE("Reporting period: January 1, 2025 - December 31, 2025", 1),
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "publication_date": None,
                "zero_incidents_quote": None,
            },
            "incidents": [
                {
                    "organization_quote": _QUOTE("Zeta Psi Fraternity", 1),
                    "description_quote": _QUOTE(
                        "During Fall 2025 recruitment, new members were required to "
                        "consume alcohol during a pledge event.",
                        1,
                    ),
                    "findings_quote": _QUOTE(
                        "The organization was investigated and found responsible for hazing.", 1
                    ),
                    "sanction_quotes": [_QUOTE("Sanction: suspension through Spring 2027.", 1)],
                    "alcohol_involved": True,
                    "drugs_involved": None,
                    "dates": {**_NULL_DATES, "incident_quote": _QUOTE("Fall 2025", 1)},
                }
            ],
        }

    if unitid == "200002":
        # eastview's decoy menu PDF, or its own index/listing page -- neither is a CHTR.
        return {
            "schema_version": 1,
            "is_chtr": False,
            "document": {
                "title_quote": None,
                "reporting_period_quote": None,
                "reporting_period_start": None,
                "reporting_period_end": None,
                "publication_date": None,
                "zero_incidents_quote": None,
            },
            "incidents": [],
        }

    if unitid == "200003":  # westfield: scanned, zero_incidents_quote can't anchor
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                "title_quote": None,
                "reporting_period_quote": None,
                "reporting_period_start": None,
                "reporting_period_end": None,
                "publication_date": None,
                "zero_incidents_quote": _QUOTE(
                    "No hazing incidents were reported during the 2025 reporting period.", 1
                ),
            },
            "incidents": [],
        }

    if unitid == "200006":  # hillcrest: genuine zero-incident report, anchorable
        return {
            "schema_version": 1,
            "is_chtr": True,
            "document": {
                "title_quote": _QUOTE("Campus Hazing Transparency Report"),
                "reporting_period_quote": _QUOTE("Reporting period: January 1, 2025 - December 31, 2025"),
                "reporting_period_start": "2025-01-01",
                "reporting_period_end": "2025-12-31",
                "publication_date": None,
                "zero_incidents_quote": _QUOTE("No hazing incidents were reported during this reporting period."),
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
        if validate_results != {"archived": 6, "skipped": 0, "pending": 0, "failed": 0}:
            failures.append(f"validate run 1: unexpected results {validate_results!r}")

        def _validation_for(inst_dir: str, hash16: str) -> dict:
            path = archive_local_root / "archive" / inst_dir / "2026" / "docs" / hash16 / "ai" / "extract_v1" / "validation.json"
            return json.loads(path.read_text())

        def _hash16_for(inst_dir: str) -> str:
            status = json.loads((archive_local_root / "archive" / inst_dir / "2026" / "status.json").read_text())
            return short_hash(status["documents"][0])

        # north-ridge: both incidents anchor cleanly, but with no crosscheck wired up
        # yet neither can reach "standard" -- both land "flagged" with no reasons.
        nr_hash = _hash16_for("200001_north-ridge-college")
        nr = _validation_for("200001_north-ridge-college", nr_hash)
        if not nr["valid"]:
            failures.append(f"north-ridge: expected valid incidents.json, got errors {nr['schema_errors']!r}")
        if len(nr["incidents"]) != 2 or any(inc["tier"] != "flagged" for inc in nr["incidents"]):
            failures.append(f"north-ridge: expected 2 incidents both tier=flagged, got {nr['incidents']!r}")
        if any(inc["flagged_reasons"] for inc in nr["incidents"]):
            failures.append(f"north-ridge: expected no flagged_reasons (clean anchoring), got {[inc['flagged_reasons'] for inc in nr['incidents']]!r}")
        if not all(inc["quotes"]["organization_quote"]["anchored"] for inc in nr["incidents"]):
            failures.append("north-ridge: expected both organization_quotes to anchor")

        # eastview: 3 documents (index page, real CHTR PDF, decoy PDF)
        ev_status = json.loads((archive_local_root / "archive" / "200002_eastview-university" / "2026" / "status.json").read_text())
        ev_validations = [_validation_for("200002_eastview-university", short_hash(h)) for h in ev_status["documents"]]
        chtr_validation = next((v for v in ev_validations if v["incidents"]), None)
        if chtr_validation is None:
            failures.append("eastview: expected exactly one document with a non-empty incidents array")
        else:
            if chtr_validation["incidents"][0]["tier"] != "flagged":
                failures.append(f"eastview CHTR PDF: expected tier=flagged, got {chtr_validation['incidents'][0]!r}")
            if "sanction_contains_suspension_or_expulsion" not in chtr_validation["incidents"][0]["flagged_reasons"]:
                failures.append(
                    f"eastview CHTR PDF: expected suspension flag, got {chtr_validation['incidents'][0]['flagged_reasons']!r}"
                )
        non_chtr = [v for v in ev_validations if v is not chtr_validation]
        if len(non_chtr) != 2 or any(v["incidents"] or v["document"]["tier"] is not None for v in non_chtr):
            failures.append(f"eastview: expected the other 2 documents to be non-CHTR (tier=None, incidents=[]), got {non_chtr!r}")

        # westfield: scanned, zero_incidents_quote can't anchor against empty text
        wf_hash = _hash16_for("200003_westfield-institute")
        wf = _validation_for("200003_westfield-institute", wf_hash)
        if wf["document"]["tier"] != "flagged":
            failures.append(f"westfield: expected document.tier=flagged, got {wf['document']!r}")
        if "empty_text_layer" not in wf["document"]["flagged_reasons"]:
            failures.append(f"westfield: expected empty_text_layer flagged reason, got {wf['document']['flagged_reasons']!r}")
        if wf["document"]["zero_incidents_quote"]["anchored"]:
            failures.append("westfield: zero_incidents_quote should not anchor against empty text.txt")

        # hillcrest: genuine zero-incident report, anchorable -- the "fast" tier case
        hc_hash = _hash16_for("200006_hillcrest-academy")
        hc = _validation_for("200006_hillcrest-academy", hc_hash)
        if hc["document"]["tier"] != "fast":
            failures.append(f"hillcrest: expected document.tier=fast, got {hc['document']!r}")
        if hc["document"]["flagged_reasons"]:
            failures.append(f"hillcrest: expected no flagged_reasons for a fast-tier report, got {hc['document']['flagged_reasons']!r}")
        if not hc["document"]["zero_incidents_quote"]["anchored"]:
            failures.append("hillcrest: zero_incidents_quote should anchor cleanly against its own text.txt")

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
    print("ok    validate run 1: schema validation + anchoring + tiering all correct")
    print("ok    north-ridge: clean incidents land flagged (no crosscheck wired up yet), not standard")
    print("ok    eastview: real CHTR PDF flagged for suspension sanction; decoy PDF + index page non-CHTR")
    print("ok    westfield: scanned/empty-text zero-incident report flagged, not fast")
    print("ok    hillcrest: anchorable zero-incident report lands fast")
    print("ok    make_packets / validate run 2: idempotent, nothing re-written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
