"""Phase 7b smoke check: the review app (Worker) end-to-end against a real fixture
archive, driven over HTTP against a real `wrangler dev` process (Miniflare's local R2
simulation) -- not mocked. Complements jobs/05-review/app/worker/test/*.test.ts (unit
tests of the TS logic in isolation, run via `npm test` in that directory) by exercising
the actual HTTP surface: routing, the R2 binding, CORS, and the DEV_MODE
reviewer-identity stub.

Builds the same archive tests/test_phase7a_review.py does (crawl + normalize
fixtures/crawl_pages/, make_packets + hand-authored incidents.json, validate.py) plus
the hillcrest zero-incident ("fast" tier) fixture from tests/test_phase4_extract.py /
tests/test_phase5_publish.py, seeds it into the Worker's local R2 simulation via the
DEV_MODE-only POST /api/dev-seed route, then drives:
  - GET /api/queue returns the expected items, ordered fast -> standard -> flagged
  - GET /api/document returns the extraction/validation/existingReview for a queue item
  - POST /api/review: an approved incident-level review lands and drops the item from
    the queue; the reviewer field is ignored client-side -- the Worker stamps the
    DEV_MODE identity onto what's actually written (confirmed via GET /api/dev-dump)
  - POST /api/review: an escalated review stays in the queue as escalated_pending
  - POST /api/review: a second_review resolving that escalation drops it from the queue
  - POST /api/review: a document-level (incident_index null) approval for hillcrest
  - schema-invalid / hash-mismatched reviews are rejected (422), nothing written

Requires `node`/`npx` (wrangler) on PATH; skips (prints SKIP, exit 0) if unavailable.

Run with: .venv/bin/python tests/test_phase7b_review_app.py
"""
import base64
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import requests  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import sha256_bytes, short_hash  # noqa: E402

FIXTURES = ROOT / "fixtures" / "crawl_pages"
WORKER_DIR = ROOT / "jobs" / "05-review" / "app" / "worker"


def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def _start_fixture_server(directory: Path):
    handler = partial(_QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _add_hillcrest(archive_root: Path) -> str:
    """Same fixture tests/test_phase4_extract.py / tests/test_phase5_publish.py build:
    a genuine zero-incident report, hand-added directly to the archive."""
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
    r2.put_bytes(f"{doc_dir}/original/index.html", content)
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
    "incident_quote": None, "incident_start": None, "incident_end": None,
    "investigation_initiated": None, "resolved": None,
}
_EMPTY_DOCUMENT = {
    "title_quote": None, "reporting_period_quote": None, "reporting_period_start": None,
    "reporting_period_end": None, "publication_date": None, "zero_incidents_quote": None,
}


def _incidents_for(manifest: dict) -> dict | None:
    unitid, source_url, content_type = manifest["unitid"], manifest["source_url"], manifest["content_type"]

    if unitid == "200001":  # north-ridge: two incidents -> standard/flagged tier queue items
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
        return {  # eastview's real CHTR PDF -- one incident (flagged: suspension sanction)
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

    if unitid == "200002":  # eastview's decoy PDF / index page -- not a CHTR, never queued
        return {"schema_version": 1, "is_chtr": False, "document": dict(_EMPTY_DOCUMENT), "incidents": []}

    if unitid == "200006":  # hillcrest (hand-added): genuine zero-incident report -> "fast" tier
        return {
            "schema_version": 1, "is_chtr": True,
            "document": {
                **_EMPTY_DOCUMENT,
                "reporting_period_start": "2025-01-01", "reporting_period_end": "2025-12-31",
                "zero_incidents_quote": _QUOTE("No hazing incidents were reported during this reporting period."),
            },
            "incidents": [],
        }

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


def _collect_seed_files(archive_local_root: Path) -> list[dict]:
    files = []
    base = archive_local_root / "archive"
    for path in sorted(base.rglob("*")):
        if path.is_file():
            key = "archive/" + "/".join(path.relative_to(base).parts)
            files.append({"key": key, "content": base64.b64encode(path.read_bytes()).decode("ascii")})
    return files


def _wait_for_worker(base_url: str, proc: subprocess.Popen, timeout: float = 45) -> None:
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"wrangler dev exited early with code {proc.returncode}")
        try:
            r = requests.get(f"{base_url}/api/queue", timeout=2)
            if r.status_code == 200:
                return
        except requests.RequestException as e:
            last_err = e
        time.sleep(0.5)
    raise RuntimeError(f"worker never became ready at {base_url}: {last_err}")


def main() -> int:
    if shutil.which("npx") is None:
        print("SKIP  no npx/node on PATH -- cannot run wrangler dev for this smoke check")
        return 0

    # Miniflare persists its local R2 simulation to disk *per project directory*,
    # independent of --port -- a stray manual `wrangler dev` session (or a previous,
    # interrupted run of this same test) would otherwise leak reviews/documents into
    # this run's "fresh" archive, since every run seeds the exact same content-derived
    # keys (fixtures/crawl_pages/ never changes). Wipe it so every run starts from a
    # genuinely empty bucket, same as every other phase's tests use a throwaway temp
    # dir / scratch database for isolation.
    shutil.rmtree(WORKER_DIR / ".wrangler" / "state", ignore_errors=True)

    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase7b_"))
    archive_local_root = tmp_root / "archive_root"
    archive_local_root.mkdir()
    tasks_dir = tmp_root / "tasks_extract"

    prior_env = {k: os.environ.get(k) for k in
                 ["ARCHIVE_LOCAL_ROOT", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]}
    os.environ["ARCHIVE_LOCAL_ROOT"] = str(archive_local_root)
    for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]:
        os.environ.pop(var, None)

    fixture_server, fixture_thread = _start_fixture_server(FIXTURES)
    fixture_port = fixture_server.server_address[1]
    schools_csv = tmp_root / "schools.csv"
    template = (FIXTURES / "schools_template.csv").read_text()
    schools_csv.write_text(template.replace("{BASE_URL}", f"http://127.0.0.1:{fixture_port}"))

    wrangler_proc: subprocess.Popen | None = None

    try:
        archive_run = _load_module("job_02_archive_run", "jobs/02-archive/run.py")
        normalize_run = _load_module("job_03_normalize_run", "jobs/03-normalize/run.py")
        make_packets = _load_module("job_04_extract_make_packets", "jobs/04-extract/make_packets.py")
        validate = _load_module("job_04_extract_validate", "jobs/04-extract/validate.py")

        archive_run.run(schools_csv=schools_csv, year=2026)
        normalize_run.run(prefix="archive/")
        hc_dir = _add_hillcrest(archive_local_root)
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
        hc_hash = sha256_bytes(r2.get_bytes(f"{hc_dir}/ai/extract_v1/incidents.json"))

        # ── start wrangler dev (Miniflare's local R2 simulation, no live credentials) ──
        worker_port = _free_port()
        base_url = f"http://127.0.0.1:{worker_port}"
        wrangler_proc = subprocess.Popen(
            ["npx", "wrangler", "dev", "--port", str(worker_port)],
            cwd=str(WORKER_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        _wait_for_worker(base_url, wrangler_proc)

        # ── seed the fixture archive into the Worker's simulated R2 ──
        seed_files = _collect_seed_files(archive_local_root)
        seed_resp = requests.post(f"{base_url}/api/dev-seed", json={"files": seed_files}, timeout=15)
        if seed_resp.status_code != 200 or seed_resp.json().get("seeded") != len(seed_files):
            failures.append(f"dev-seed: expected 200/{{seeded: {len(seed_files)}}}, got {seed_resp.status_code} {seed_resp.text}")

        # ── 1. queue ordering: fast (hillcrest) -> standard/flagged (north-ridge x2, eastview) ──
        queue = requests.get(f"{base_url}/api/queue", timeout=10).json()
        tiers = [item["tier"] for item in queue]
        if tiers != sorted(tiers, key=lambda t: {"fast": 0, "standard": 1, "flagged": 2}[t]):
            failures.append(f"1: queue not ordered fast->standard->flagged: {tiers!r}")
        if len(queue) != 4:
            failures.append(f"1: expected 4 queue items (hillcrest doc + 2 north-ridge incidents + 1 eastview incident), got {len(queue)}: {queue!r}")
        hc_item = next((i for i in queue if i["docDir"] == hc_dir), None)
        if hc_item is None or hc_item["incidentIndex"] is not None or hc_item["tier"] != "fast":
            failures.append(f"1: expected a fast-tier, incidentIndex=null queue item for hillcrest, got {hc_item!r}")

        # ── 2. GET /api/document for a north-ridge incident ──
        doc = requests.get(f"{base_url}/api/document", params={"doc_dir": nr_dir, "incident_index": "0"}, timeout=10).json()
        if doc.get("existingReview") is not None:
            failures.append(f"2: expected no existing review for an unreviewed incident, got {doc.get('existingReview')!r}")
        if doc.get("incidentsJson", {}).get("incidents", [{}])[0].get("organization_quote", {}).get("text") != "Sigma Alpha Fraternity":
            failures.append(f"2: unexpected /api/document payload: {doc!r}")

        # ── 3. approve north-ridge incident 0 -- lands, drops from queue, reviewer stamped by the Worker ──
        review_payload = {
            "schema_version": 1,
            "extraction_ref": {"file_hash": nr_hash, "incident_index": 0},
            "tier": "flagged",
            "decision": "approved",
            "rejection_reason": None,
            "corrections": None,
            "reviewer": "someone-the-client-claims-to-be",  # must be ignored/overwritten server-side
            "reviewed_at": "2026-02-10T18:00:00Z",
            "second_review": None,
        }
        resp = requests.post(f"{base_url}/api/review", json={"doc_dir": nr_dir, "review": review_payload}, timeout=10)
        if resp.status_code != 200:
            failures.append(f"3: expected 200, got {resp.status_code} {resp.text}")
        dump = requests.get(f"{base_url}/api/dev-dump", params={"prefix": f"{nr_dir}/reviews/"}, timeout=10).json()
        if not dump["keys"] or "dev-reviewer" not in dump["keys"][0]:
            failures.append(f"3: expected a reviews/ key stamped with the DEV_MODE reviewer, got {dump!r}")
        queue_after = requests.get(f"{base_url}/api/queue", timeout=10).json()
        if any(i["docDir"] == nr_dir and i["incidentIndex"] == 0 for i in queue_after):
            failures.append("3: approved incident should have dropped out of the queue")

        # ── 4. escalate north-ridge incident 1 -- stays in queue as escalated_pending ──
        escalate_payload = {
            "schema_version": 1,
            "extraction_ref": {"file_hash": nr_hash, "incident_index": 1},
            "tier": "flagged",
            "decision": "escalated",
            "rejection_reason": None,
            "corrections": None,
            "reviewer": "ignored",
            "reviewed_at": "2026-02-10T18:01:00Z",
            "second_review": None,
        }
        requests.post(f"{base_url}/api/review", json={"doc_dir": nr_dir, "review": escalate_payload}, timeout=10)
        queue_after = requests.get(f"{base_url}/api/queue", timeout=10).json()
        escalated_item = next((i for i in queue_after if i["docDir"] == nr_dir and i["incidentIndex"] == 1), None)
        if escalated_item is None or escalated_item["status"] != "escalated_pending":
            failures.append(f"4: expected north-ridge incident 1 to stay queued as escalated_pending, got {escalated_item!r}")

        # ── 5. second_review resolves the escalation -- drops from the queue ──
        doc2 = requests.get(f"{base_url}/api/document", params={"doc_dir": nr_dir, "incident_index": "1"}, timeout=10).json()
        existing = doc2.get("existingReview")
        if existing is None:
            failures.append("5: expected /api/document to surface the pending escalation as existingReview")
        else:
            resolved = dict(existing)
            resolved["second_review"] = {
                "decision": "approved", "rejection_reason": None, "corrections": None,
                "reviewer": "ignored", "reviewed_at": "2026-02-11T09:00:00Z",
            }
            requests.post(f"{base_url}/api/review", json={"doc_dir": nr_dir, "review": resolved}, timeout=10)
            queue_after = requests.get(f"{base_url}/api/queue", timeout=10).json()
            if any(i["docDir"] == nr_dir and i["incidentIndex"] == 1 for i in queue_after):
                failures.append("5: escalation resolved via second_review should have dropped out of the queue")
            resolved_doc = requests.get(
                f"{base_url}/api/document", params={"doc_dir": nr_dir, "incident_index": "1"}, timeout=10
            ).json()
            written_second_review = (resolved_doc.get("existingReview") or {}).get("second_review") or {}
            if written_second_review.get("reviewer") != "dev-reviewer":
                failures.append(
                    "5: the client submitted second_review.reviewer='ignored', but the Worker must stamp its "
                    f"own resolved identity there too (not just the top-level reviewer) -- got {written_second_review!r}"
                )

        # ── 6. document-level (zero-incident) approval for hillcrest ──
        hc_payload = {
            "schema_version": 1,
            "extraction_ref": {"file_hash": hc_hash, "incident_index": None},
            "tier": "fast",
            "decision": "approved",
            "rejection_reason": None,
            "corrections": None,
            "reviewer": "ignored",
            "reviewed_at": "2026-02-10T18:03:00Z",
            "second_review": None,
        }
        resp6 = requests.post(f"{base_url}/api/review", json={"doc_dir": hc_dir, "review": hc_payload}, timeout=10)
        if resp6.status_code != 200:
            failures.append(f"6: expected 200 for hillcrest's document-level approval, got {resp6.status_code} {resp6.text}")
        dump6 = requests.get(f"{base_url}/api/dev-dump", params={"prefix": f"{hc_dir}/reviews/"}, timeout=10).json()
        if not any(k.startswith(f"{hc_dir}/reviews/document_") for k in dump6["keys"]):
            failures.append(f"6: expected a reviews/document_... key for hillcrest, got {dump6!r}")
        queue_after = requests.get(f"{base_url}/api/queue", timeout=10).json()
        if any(i["docDir"] == hc_dir for i in queue_after):
            failures.append("6: hillcrest should have dropped out of the queue after approval")

        # ── 7. schema-invalid / hash-mismatched reviews are rejected ──
        bad = dict(review_payload)
        bad["decision"] = "maybe"
        resp7a = requests.post(f"{base_url}/api/review", json={"doc_dir": ev_dir, "review": bad}, timeout=10)
        if resp7a.status_code != 422:
            failures.append(f"7a: expected 422 for a schema-invalid decision, got {resp7a.status_code} {resp7a.text}")
        mismatched = dict(review_payload)
        mismatched["extraction_ref"] = {"file_hash": "0" * 64, "incident_index": 0}
        resp7b = requests.post(f"{base_url}/api/review", json={"doc_dir": ev_dir, "review": mismatched}, timeout=10)
        if resp7b.status_code != 422:
            failures.append(f"7b: expected 422 for a file_hash matching no extraction, got {resp7b.status_code} {resp7b.text}")

        # ── final: north-ridge (both incidents) + hillcrest gone, only eastview's flagged incident left ──
        final_queue = requests.get(f"{base_url}/api/queue", timeout=10).json()
        remaining = {(i["docDir"], i["incidentIndex"]) for i in final_queue}
        if remaining != {(ev_dir, 0)}:
            failures.append(f"final: expected only eastview's incident 0 left in the queue, got {remaining!r}")

    finally:
        if wrangler_proc is not None:
            wrangler_proc.terminate()
            try:
                wrangler_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                wrangler_proc.kill()
        fixture_server.shutdown()
        fixture_thread.join(timeout=5)
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
    print("ok    queue ordered fast -> standard -> flagged, hillcrest surfaced as a document-level fast item")
    print("ok    GET /api/document returns the extraction/validation for a queue item")
    print("ok    approving an incident lands it in reviews/ (Worker-stamped reviewer) and drops it from the queue")
    print("ok    an escalated review stays queued as escalated_pending")
    print("ok    a second_review resolving an escalation drops it from the queue")
    print("ok    a document-level (incident_index null) approval works for a zero-incident report")
    print("ok    schema-invalid and hash-mismatched reviews are rejected with 422")
    return 0


if __name__ == "__main__":
    sys.exit(main())
