"""Phase 7a / Phase 15 smoke check: jobs/05-review/ingest.py (the review.json write path,
v3.0 -- no tier, no escalation, no second_review, no quote-anchoring on correction).

Builds a real archive the same way test_phase4_extract.py does (crawl + normalize
fixtures/crawl_pages/, make_packets + hand-authored v2 incidents.json standing in for
the agent, then validate.py) so ingest.py is tested against genuine
extract_v1/incidents.json, not synthetic stand-ins. north-ridge (HTML, 2 incidents),
eastview's real CHTR PDF (1 incident), and eastview's non-CHTR index page (0 incidents,
used for the document-level review cases) are finished/validated.

Exercises, all via ingest.ingest_review() directly (no live R2, no Worker):
  - a valid `approved` review lands at the expected reviews/ key, with the expected
    reviewer-slug/ts filename derivation, and byte-identical content;
  - a review whose extraction_ref.file_hash matches nothing under doc_dir/ai/ is
    rejected, nothing written (invariant 9's pinning is actually enforced);
  - an out-of-range incident_index is rejected;
  - a review that fails schema.json (bad decision enum, unknown field) is rejected;
  - a `corrected` review whose correction targets a known correctable field succeeds;
  - a `corrected` review whose correction targets an unknown/uncorrectable field_name
    is rejected, nothing written;
  - a document-level (incident_index null) review of a genuine zero-incident document
    succeeds;
  - a document-level review resolving to `corrected` is rejected (no per-field
    correction vocabulary for the document object);
  - `organization_review` on a document-level review is rejected (nothing to review);
  - `organization_review` on a normal incident review is accepted and stored as-is.

Run with: .venv/bin/python tests/test_phase7a_review.py
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
from lib.hashing import short_hash, sha256_bytes  # noqa: E402

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


_NULL_DATES = {
    "incident_start_raw": "", "incident_start_normalized": None, "incident_start_precision": "Unknown",
    "incident_end_raw": "", "incident_end_normalized": None, "incident_end_precision": "Unknown",
    "investigation_start_date_raw": "", "investigation_start_date": None,
    "investigation_end_date_raw": "", "investigation_end_date": None,
    "notice_date_raw": "", "notice_date": None,
}
_EMPTY_DOCUMENT = {
    "reporting_period_start": None, "reporting_period_end": None,
    "publication_date": None, "zero_incidents_statement": None,
}


def _incidents_for(manifest: dict) -> dict | None:
    unitid, source_url, content_type = manifest["unitid"], manifest["source_url"], manifest["content_type"]

    if unitid == "200001":  # north-ridge: two incidents
        return {
            "schema_version": 2, "is_chtr": True,
            "document": {**_EMPTY_DOCUMENT, "reporting_period_start": "2025-01-01", "reporting_period_end": "2025-12-31"},
            "incidents": [
                {
                    "organization_name_raw": "Sigma Alpha Fraternity", "organization_name_normalized": "Sigma Alpha",
                    "organization_type": "Fraternity",
                    "description_raw": "new members of Sigma Alpha Fraternity were required to perform "
                                        "physically demanding tasks late at night as part of an unofficial "
                                        "initiation ritual.",
                    "findings_raw": "The organization was found responsible for hazing.",
                    "sanctions_raw": "Sanction: probation through Fall 2026.",
                    "alcohol_involved": "No", "drugs_involved": "No", "determination_status": "Determined hazing",
                    "dates": {**_NULL_DATES, "incident_start_raw": "September 2025", "incident_start_normalized": "2025-09-01"},
                    "extraction_confidence": 0.9, "flags": [],
                },
                {
                    "organization_name_raw": "Women's Club Rowing", "organization_name_normalized": "Women's Club Rowing",
                    "organization_type": "Club Sport",
                    "description_raw": "members of the Women's Club Rowing team required new members to "
                                        "consume alcohol at a team event.",
                    "findings_raw": "The organization was found responsible for hazing.",
                    "sanctions_raw": "Sanction: loss of club-sport funding for one year.",
                    "alcohol_involved": "Yes", "drugs_involved": "Not specified", "determination_status": "Determined hazing",
                    "dates": {**_NULL_DATES, "incident_start_raw": "October 2025"},
                    "extraction_confidence": 0.8, "flags": [],
                },
            ],
        }

    if unitid == "200002" and content_type == "application/pdf" and "decoy" not in source_url:
        return {  # eastview's real CHTR PDF -- one incident
            "schema_version": 2, "is_chtr": True,
            "document": {**_EMPTY_DOCUMENT, "reporting_period_start": "2025-01-01", "reporting_period_end": "2025-12-31"},
            "incidents": [
                {
                    "organization_name_raw": "Zeta Psi Fraternity", "organization_name_normalized": "Zeta Psi",
                    "organization_type": "Fraternity",
                    "description_raw": "During Fall 2025 recruitment, new members were required to consume "
                                        "alcohol during a pledge event.",
                    "findings_raw": "The organization was investigated and found responsible for hazing.",
                    "sanctions_raw": "Sanction: suspension through Spring 2027.",
                    "alcohol_involved": "Yes", "drugs_involved": "Not specified", "determination_status": "Determined hazing",
                    "dates": {**_NULL_DATES, "incident_start_raw": "Fall 2025", "incident_start_precision": "Academic term"},
                    "extraction_confidence": 0.7, "flags": [],
                }
            ],
        }

    if unitid == "200002":  # eastview's decoy PDF / index page -- not a CHTR, zero incidents
        return {"schema_version": 2, "is_chtr": False, "document": dict(_EMPTY_DOCUMENT), "incidents": []}

    return None  # westfield / others: leave unfinished, not needed by this test


def _finish_packets(tasks_dir: Path) -> None:
    for packet_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        metadata = json.loads((packet_dir / "metadata.json").read_text())
        manifest = json.loads(r2.get_bytes(f"{metadata['doc_dir']}/manifest.json"))
        incidents = _incidents_for(manifest)
        if incidents is None:
            continue
        (packet_dir / "incidents.json").write_text(json.dumps(incidents, indent=2))
        metadata["model"] = "test-harness"
        metadata["created"] = "2026-02-01T00:00:00Z"
        (packet_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))


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


def _base_review(file_hash: str, index: int | None, **overrides) -> dict:
    review = {
        "schema_version": 2,
        "extraction_ref": {"file_hash": file_hash, "incident_index": index},
        "decision": "approved",
        "rejection_reason": None,
        "corrections": [],
        "organization_review": None,
        "reviewer": "jane-reviewer",
        "reviewed_at": "2026-02-10T18:00:00Z",
    }
    review.update(overrides)
    return review


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase7a_"))
    archive_local_root = tmp_root / "archive_root"
    archive_local_root.mkdir()
    tasks_dir = tmp_root / "tasks_extract"

    prior_env = {k: os.environ.get(k) for k in
                 ["ARCHIVE_LOCAL_ROOT", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]}
    os.environ["ARCHIVE_LOCAL_ROOT"] = str(archive_local_root)
    for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]:
        os.environ.pop(var, None)

    server, thread = _start_server(FIXTURES)
    port = server.server_address[1]
    schools_csv = tmp_root / "schools.csv"
    template = (FIXTURES / "schools_template.csv").read_text()
    schools_csv.write_text(template.replace("{BASE_URL}", f"http://127.0.0.1:{port}"))

    try:
        archive_run = _load_module("job_02_archive_run", "jobs/02-archive/run.py")
        normalize_run = _load_module("job_03_normalize_run", "jobs/03-normalize/run.py")
        make_packets = _load_module("job_04_extract_make_packets", "jobs/04-extract/make_packets.py")
        validate = _load_module("job_04_extract_validate", "jobs/04-extract/validate.py")
        ingest = _load_module("job_05_review_ingest", "jobs/05-review/ingest.py")

        archive_run.run(schools_csv=schools_csv, year=2026)
        normalize_run.run(prefix="archive/")
        make_packets.run(prefix="archive/", tasks_dir=tasks_dir)
        _finish_packets(tasks_dir)
        validate_results = validate.run(tasks_dir=tasks_dir)
        if validate_results["failed"] != 0:
            failures.append(f"setup: validate.py reported failures: {validate_results!r}")

        nr_dir = f"archive/200001_north-ridge-college/2026/docs/{_hash16_for(archive_local_root, '200001_north-ridge-college')}"
        ev_dir = (
            f"archive/200002_eastview-university/2026/docs/"
            f"{_hash16_for(archive_local_root, '200002_eastview-university', predicate=lambda m: m['content_type'] == 'application/pdf' and 'decoy' not in m['source_url'])}"
        )
        ev_index_dir = (
            f"archive/200002_eastview-university/2026/docs/"
            f"{_hash16_for(archive_local_root, '200002_eastview-university', predicate=lambda m: m['content_type'] == 'text/html')}"
        )
        nr_hash = sha256_bytes(r2.get_bytes(f"{nr_dir}/ai/extract_v1/incidents.json"))
        ev_hash = sha256_bytes(r2.get_bytes(f"{ev_dir}/ai/extract_v1/incidents.json"))
        ev_index_hash = sha256_bytes(r2.get_bytes(f"{ev_index_dir}/ai/extract_v1/incidents.json"))

        def reviews_of(doc_dir: str) -> list[str]:
            return [k for k in r2.list_keys(f"{doc_dir}/reviews/")]

        # ── 1. valid approved review lands at the expected key, byte-identical content ──
        review = _base_review(nr_hash, 0, reviewer="Jane Doe <jane@x.edu>", reviewed_at="2026-02-10T18:05:30Z")
        key = ingest.ingest_review(nr_dir, review)
        expected_key = f"{nr_dir}/reviews/0_jane-doe-jane-x-edu_20260210T180530Z.review.json"
        if key != expected_key:
            failures.append(f"1: expected key {expected_key!r}, got {key!r}")
        elif not r2.exists(key):
            failures.append(f"1: {key} was not actually written")
        elif json.loads(r2.get_bytes(key)) != review:
            failures.append("1: written review.json content does not match input")

        # ── 2. file_hash pinned to nothing under this doc_dir -> rejected, nothing written ──
        before = reviews_of(ev_dir)
        try:
            ingest.ingest_review(ev_dir, _base_review("0" * 64, 0))
            failures.append("2: expected IngestError for a file_hash matching no extraction, none raised")
        except ingest.IngestError:
            pass
        if reviews_of(ev_dir) != before:
            failures.append("2: a rejected review was written anyway")

        # ── 3. out-of-range incident_index -> rejected ──
        try:
            ingest.ingest_review(nr_dir, _base_review(nr_hash, 5))
            failures.append("3: expected IngestError for out-of-range incident_index, none raised")
        except ingest.IngestError:
            pass

        # ── 4. schema-invalid reviews -> rejected ──
        try:
            ingest.ingest_review(nr_dir, _base_review(nr_hash, 1, decision="maybe"))
            failures.append("4a: expected IngestError for a bad decision enum, none raised")
        except ingest.IngestError:
            pass
        bad_extra_field = _base_review(nr_hash, 1)
        bad_extra_field["not_a_real_field"] = "x"
        try:
            ingest.ingest_review(nr_dir, bad_extra_field)
            failures.append("4b: expected IngestError for an unknown field (additionalProperties: false), none raised")
        except ingest.IngestError:
            pass

        # ── 5. corrected review targeting a known correctable field -> succeeds ──
        good_correction = _base_review(
            ev_hash, 0, decision="corrected", reviewer="jane-reviewer", reviewed_at="2026-02-10T19:00:00Z",
            corrections=[{"field_name": "dates.incident_start_normalized", "original_value": None,
                          "corrected_value": "2025-10-01", "correction_type": ["Minor cleanup"]}],
        )
        key5 = ingest.ingest_review(ev_dir, good_correction)
        if not r2.exists(key5):
            failures.append("5: valid corrected review was not written")

        # ── 6. corrected review targeting an unknown field_name -> rejected ──
        before = reviews_of(ev_dir)
        bad_correction = _base_review(
            ev_hash, 0, decision="corrected", reviewer="jane-reviewer", reviewed_at="2026-02-10T19:05:00Z",
            corrections=[{"field_name": "not_a_real_field", "original_value": None,
                          "corrected_value": "x", "correction_type": ["Minor cleanup"]}],
        )
        try:
            ingest.ingest_review(ev_dir, bad_correction)
            failures.append("6: expected IngestError for an uncorrectable field_name, none raised")
        except ingest.IngestError:
            pass
        if reviews_of(ev_dir) != before:
            failures.append("6: a rejected corrected review was written anyway")

        # ── 7. document-level review of a genuine zero-incident document -> succeeds ──
        doc_review = _base_review(ev_index_hash, None, reviewer="jane-reviewer", reviewed_at="2026-02-10T20:00:00Z")
        key7 = ingest.ingest_review(ev_index_dir, doc_review)
        if "document_" not in key7 or not r2.exists(key7):
            failures.append(f"7: document-level review not written as expected, got key {key7!r}")

        # ── 8. document-level review resolving to "corrected" -> rejected ──
        try:
            ingest.ingest_review(ev_index_dir, _base_review(
                ev_index_hash, None, decision="corrected", reviewed_at="2026-02-10T20:05:00Z",
                corrections=[{"field_name": "description_raw", "original_value": None,
                              "corrected_value": "x", "correction_type": ["Minor cleanup"]}],
            ))
            failures.append("8: expected IngestError for a document-level 'corrected' review, none raised")
        except ingest.IngestError:
            pass

        # ── 9. organization_review on a document-level review -> rejected ──
        try:
            ingest.ingest_review(ev_index_dir, _base_review(
                ev_index_hash, None, reviewed_at="2026-02-10T20:10:00Z",
                organization_review={"decision": "approved", "corrected_organization_type": None},
            ))
            failures.append("9: expected IngestError for organization_review on a document-level review, none raised")
        except ingest.IngestError:
            pass

        # ── 10. organization_review on a normal incident review -> accepted, stored ──
        org_review = _base_review(
            nr_hash, 0, reviewer="jane-reviewer", reviewed_at="2026-02-10T20:15:00Z",
            organization_review={"decision": "corrected", "corrected_organization_type": "Honor/Leadership Society"},
        )
        key10 = ingest.ingest_review(nr_dir, org_review)
        stored = json.loads(r2.get_bytes(key10))
        if stored.get("organization_review") != org_review["organization_review"]:
            failures.append(f"10: organization_review not stored as submitted, got {stored.get('organization_review')!r}")

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
    print("ok    approved review lands at the expected reviews/ key with byte-identical content")
    print("ok    reviewer-slug/ts filename derivation matches the confirmed convention")
    print("ok    file_hash pinned to no extraction under doc_dir is rejected, nothing written")
    print("ok    out-of-range incident_index is rejected")
    print("ok    schema-invalid reviews (bad enum, unknown field) are rejected")
    print("ok    corrected review targeting a known correctable field succeeds")
    print("ok    corrected review targeting an unknown field_name is rejected, nothing written")
    print("ok    document-level review of a genuine zero-incident document succeeds")
    print("ok    document-level review resolving to 'corrected' is rejected")
    print("ok    organization_review is rejected on a document-level review, accepted on a normal one")
    return 0


if __name__ == "__main__":
    sys.exit(main())
