"""Phase 7a smoke check: jobs/05-review/ingest.py (the review.json write path).

Builds a real archive the same way test_phase4_extract.py / test_phase5_publish.py
do (crawl + normalize fixtures/crawl_pages/, make_packets + hand-authored
incidents.json standing in for the agent, then validate.py) so ingest.py is tested
against genuine extract_v1/incidents.json + extracted/text.txt, not synthetic
stand-ins. Only north-ridge (HTML, 2 incidents) and eastview's real CHTR PDF (1
incident) are finished/validated -- that's enough surface for every ingest.py path.

Exercises, all via ingest.ingest_review() directly (no live R2, no Worker -- per
BUILD_STATUS.md's Phase 7a decision, this phase is pure Python testable locally):
  - a valid `approved` review lands at the expected reviews/ key, with the expected
    reviewer-slug/ts filename derivation, and byte-identical content;
  - a review whose extraction_ref.file_hash matches nothing under doc_dir/ai/ is
    rejected, nothing written (invariant 9's pinning is actually enforced, not just
    trusted);
  - an out-of-range incident_index is rejected;
  - a review that fails schema.json (bad decision enum, missing required key) is
    rejected;
  - a `corrected` review whose corrected quote still anchors in the document text
    succeeds;
  - a `corrected` review whose corrected quote does NOT anchor is rejected, nothing
    written (Section 10: reviewers can never introduce unanchored text);
  - second_review's decision overriding a first review's `corrected` to `approved`
    skips re-anchoring entirely (matches jobs/06-publish/rebuild.py's
    _resolved_decision rule -- corrections attached to a non-"corrected" resolved
    decision are never applied);
  - second_review's correction, when both first and second correct the *same* field
    to different values, is the one re-anchored (last-write-wins) -- a second
    reviewer approving a bad correction still gets caught.

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


_QUOTE = lambda text, page=None: {"text": text, "page": page}  # noqa: E731
_NULL_DATES = {
    "incident_quote": None, "incident_start": None, "incident_end": None,
    "investigation_initiated": None, "resolved": None,
}
_EMPTY_DOCUMENT = {
    "title_quote": None, "reporting_period_quote": None, "reporting_period_start": None,
    "reporting_period_end": None, "publication_date": None, "zero_incidents_quote": None,
}


def _incidents_for(manifest: dict) -> dict | None:
    unitid, source_url, content_type = manifest["unitid"], manifest["source_url"], manifest["content_type"]

    if unitid == "200001":  # north-ridge: two incidents
        return {
            "schema_version": 1, "is_chtr": True,
            "document": {**_EMPTY_DOCUMENT, "reporting_period_start": "2025-01-01", "reporting_period_end": "2025-12-31"},
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
                    "alcohol_involved": False, "drugs_involved": False,
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
                    "alcohol_involved": True, "drugs_involved": None,
                    "dates": {**_NULL_DATES, "incident_quote": _QUOTE("October 2025")},
                },
            ],
        }

    if unitid == "200002" and content_type == "application/pdf" and "decoy" not in source_url:
        return {  # eastview's real CHTR PDF -- one incident
            "schema_version": 1, "is_chtr": True,
            "document": {**_EMPTY_DOCUMENT, "title_quote": _QUOTE("Campus Hazing Transparency Report", 1),
                         "reporting_period_start": "2025-01-01", "reporting_period_end": "2025-12-31"},
            "incidents": [
                {
                    "organization_quote": _QUOTE("Zeta Psi Fraternity", 1),
                    "description_quote": _QUOTE(
                        "During Fall 2025 recruitment, new members were required to "
                        "consume alcohol during a pledge event.", 1,
                    ),
                    "findings_quote": _QUOTE("The organization was investigated and found responsible for hazing.", 1),
                    "sanction_quotes": [_QUOTE("Sanction: suspension through Spring 2027.", 1)],
                    "alcohol_involved": True, "drugs_involved": None,
                    "dates": {**_NULL_DATES, "incident_quote": _QUOTE("Fall 2025", 1)},
                }
            ],
        }

    if unitid == "200002":  # eastview's decoy PDF / index page -- not a CHTR
        return {"schema_version": 1, "is_chtr": False, "document": dict(_EMPTY_DOCUMENT), "incidents": []}

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


def _base_review(file_hash: str, index: int, **overrides) -> dict:
    review = {
        "schema_version": 1,
        "extraction_ref": {"file_hash": file_hash, "incident_index": index},
        "tier": "flagged",
        "decision": "approved",
        "rejection_reason": None,
        "corrections": None,
        "reviewer": "jane-reviewer",
        "reviewed_at": "2026-02-10T18:00:00Z",
        "second_review": None,
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
        nr_hash = sha256_bytes(r2.get_bytes(f"{nr_dir}/ai/extract_v1/incidents.json"))
        ev_hash = sha256_bytes(r2.get_bytes(f"{ev_dir}/ai/extract_v1/incidents.json"))

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

        # ── 5. corrected review whose corrected quote still anchors -> succeeds ──
        good_correction = _base_review(
            ev_hash, 0, decision="corrected", reviewer="jane-reviewer", reviewed_at="2026-02-10T19:00:00Z",
            corrections={"organization_quote.text": "Eastview University", "organization_quote.page": "1"},
        )
        key5 = ingest.ingest_review(ev_dir, good_correction)
        if not r2.exists(key5):
            failures.append("5: valid corrected review was not written")

        # ── 6. corrected review whose corrected quote does NOT anchor -> rejected ──
        before = reviews_of(ev_dir)
        bad_correction = _base_review(
            ev_hash, 0, decision="corrected", reviewer="jane-reviewer", reviewed_at="2026-02-10T19:05:00Z",
            corrections={"organization_quote.text": "This text does not appear anywhere in the document at all."},
        )
        try:
            ingest.ingest_review(ev_dir, bad_correction)
            failures.append("6: expected IngestError for an unanchored corrected quote, none raised")
        except ingest.IngestError:
            pass
        if reviews_of(ev_dir) != before:
            failures.append("6: a rejected corrected review was written anyway")

        # ── 7. second_review overriding "corrected" -> "approved" skips re-anchoring ──
        overridden = _base_review(
            ev_hash, 0, decision="corrected", reviewer="jane-reviewer", reviewed_at="2026-02-10T19:10:00Z",
            corrections={"organization_quote.text": "garbage text nowhere in the document"},
            second_review={
                "decision": "approved", "rejection_reason": None, "corrections": None,
                "reviewer": "john-reviewer", "reviewed_at": "2026-02-11T09:00:00Z",
            },
        )
        try:
            ingest.ingest_review(ev_dir, overridden)
        except ingest.IngestError as e:
            failures.append(f"7: second_review's approved should skip re-anchoring the first review's bad correction, but got: {e}")

        # ── 8. second_review's correction (not first's) is the one re-anchored ──
        second_wins_good_then_bad = _base_review(
            ev_hash, 0, decision="corrected", reviewer="jane-reviewer", reviewed_at="2026-02-10T19:15:00Z",
            corrections={"organization_quote.text": "Eastview University"},  # valid on its own
            second_review={
                "decision": "corrected", "rejection_reason": None,
                "corrections": {"organization_quote.text": "still nowhere in the document"},  # invalid, should win
                "reviewer": "john-reviewer", "reviewed_at": "2026-02-11T09:05:00Z",
            },
        )
        try:
            ingest.ingest_review(ev_dir, second_wins_good_then_bad)
            failures.append("8: expected second_review's invalid correction to win and be rejected, but it succeeded")
        except ingest.IngestError:
            pass

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
    print("ok    corrected review with an anchorable correction succeeds")
    print("ok    corrected review with an unanchorable correction is rejected, nothing written")
    print("ok    second_review overriding to approved skips re-anchoring the first review's correction")
    print("ok    second_review's correction (not first's) is the one re-anchored, last-write-wins")
    return 0


if __name__ == "__main__":
    sys.exit(main())
