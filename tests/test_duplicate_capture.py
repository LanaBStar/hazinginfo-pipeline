"""02-archive duplicate-capture rule: a web page whose readable text matches a document
already stored for the institution is not stored again, even when its bytes differ.

Reproduces the two shapes observed in the 2026-09 four-school run, served by a local HTTP
server that changes the HTML on EVERY request, the way the real sites do:

  - Georgia Tech (Drupal): a random `js-view-dom-id-…` attribute in every response, and
    the same listing served at both `/hazing-conduct-history` and `?page=0`. Before this
    rule, each report page was stored twice.
  - Maxient: the school logo loaded through a signed S3 link carrying the request time
    (`X-Amz-Date=…`). Before this rule, every re-scrape stored a fresh copy.

Also checks the rule does not over-reach: a page that differs only by a date IS stored
again; PDFs still dedupe on raw bytes only; the loader works on manifests that lack a
sha256; and a byte-identical re-capture reads nothing extra from the archive.

No network, no fixtures directory, no credentials.

Run with: python tests/test_duplicate_capture.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# What the date-only check serves; changed between runs by the test itself.
STATE = {"notified": "5-28-2026"}


def _load_run_module():
    spec = importlib.util.spec_from_file_location(
        "job_02_archive_run_dupes", ROOT / "jobs" / "02-archive" / "run.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _drupal_listing(rows: list[str]) -> str:
    token = uuid.uuid4().hex + uuid.uuid4().hex  # changes on every request
    items = "".join(f"<div class='violation-wrapper'><h3>{r}</h3><div><b>Violations: </b></div>"
                    f"<ol><li>Hazing.</li></ol></div>" for r in rows)
    return (
        "<html><head><title>Hazing Conduct History</title></head><body>"
        "<header><a href='/'>Home</a></header><main>"
        "<p>The Campus Hazing Transparency Report can be accessed below.</p>"
        f"<div class='view js-view-dom-id-{token}'>{items}</div>"
        "<nav class='pager'><a href='?page=0'>1</a> <a href='?page=1'>2</a></nav>"
        "</main></body></html>"
    )


def _maxient_page() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return (
        "<html><head><title>Campus Hazing Transparency Report</title></head><body>"
        f"<img src='https://s3.example/logo.png?X-Amz-Date={stamp}&X-Amz-Signature={uuid.uuid4().hex}' "
        "alt='School Logo'>"
        "<main><h1>Campus Hazing Transparency Report</h1>"
        "<p>Sigma Nu Fraternity. Date of Incident March 7, 2023. Hazing.</p>"
        "<p>2024-2025 Academic Year: There were no findings of hazing behavior during this time period.</p>"
        "</main></body></html>"
    )


def _dated_page() -> str:
    return (
        "<html><body><main><h1>Hazing Transparency Report</h1>"
        "<p>Phi Sigma Kappa. Incident Date: 1-25-2026. "
        f"Date organization was notified: {STATE['notified']}. Violations: Hazing.</p>"
        "</main></body></html>"
    )


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/drupal/hazing-conduct-history":
            body = _drupal_listing(["Sigma Nu", "Alpha Phi"] if query in ("", "page=0")
                                   else ["Theta Xi", "Chi Phi"])
        elif path == "/maxient/chtr.php":
            body = _maxient_page()
        elif path == "/dated/hazing-report":
            body = _dated_page()
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _write_csv(dest: Path, base: str) -> Path:
    dest.write_text(
        "unitid,name,state,chtr_url,url_status,evidence\n"
        f"900001,Drupal Tech,,{base}/drupal/hazing-conduct-history,confirmed,\n"
        f"900002,Maxient State,,{base}/maxient/chtr.php?MaxientState,confirmed,\n"
        f"900003,Dated College,,{base}/dated/hazing-report,confirmed,\n"
    )
    return dest


def _doc_dirs(archive: Path, inst: str, year: int) -> list[Path]:
    d = archive / inst / str(year) / "docs"
    return sorted(p for p in d.iterdir() if p.is_dir()) if d.exists() else []


def _status(archive: Path, inst: str, year: int) -> dict:
    return json.loads((archive / inst / str(year) / "status.json").read_text())


def main() -> int:
    failures: list[str] = []
    passed: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="hazinginfo_dupes_"))
    local_root = tmp / "root"
    local_root.mkdir()
    prior = os.environ.get("ARCHIVE_LOCAL_ROOT")
    os.environ["ARCHIVE_LOCAL_ROOT"] = str(local_root)

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    csv_path = _write_csv(tmp / "schools.csv", base)

    try:
        run = _load_run_module()
        archive = local_root / "archive"

        # ── Sanity: the server really does change bytes on every request ──
        a, b = run.fetch_url(f"{base}/maxient/chtr.php?MaxientState"), run.fetch_url(f"{base}/maxient/chtr.php?MaxientState")
        if a.content == b.content:
            failures.append("test server returned identical bytes twice; the test proves nothing")

        # ── Run 1, year 2026 ──
        results = run.run(schools_csv=csv_path, year=2026)
        if results != {"published": 3}:
            failures.append(f"run 1 results: expected 3 published, got {results}")

        drupal = _doc_dirs(archive, "900001_drupal-tech", 2026)
        if len(drupal) != 2:
            failures.append(f"Drupal shape: expected 2 stored documents (listing pages 1 and 2), got {len(drupal)}")
        else:
            passed.append("Drupal shape: base URL and ?page=0 stored once, page 2 stored separately")
        ds = _status(archive, "900001_drupal-tech", 2026)["documents"]
        stored = {json.loads((d / "manifest.json").read_text())["sha256"] for d in drupal}
        if set(ds) != stored or len(ds) != len(set(ds)):
            failures.append(f"Drupal shape: status.json documents {ds} should be exactly the stored hashes {stored}")
        else:
            passed.append("status.json lists only documents that exist in the archive")

        ledger = list((archive / "900001_drupal-tech" / "ledger").glob("*.json"))
        urls = {json.loads(p.read_text())["source_url"] for p in ledger}
        if not any(u.endswith("?page=0") for u in urls) or len(ledger) < 3:
            failures.append(f"Drupal shape: every URL should still get a Ledger entry, got {sorted(urls)}")
        else:
            passed.append("the skipped copy's URL still gets its Ledger entry")

        if len(_doc_dirs(archive, "900002_maxient-state", 2026)) != 1:
            failures.append("Maxient shape: expected 1 stored document in 2026")
        maxient_2026 = _status(archive, "900002_maxient-state", 2026)["documents"]

        # ── Run 2, year 2027: Maxient bytes differ, text doesn't; the dated page's text changes ──
        STATE["notified"] = "6-02-2026"
        run.run(schools_csv=csv_path, year=2027)

        if _doc_dirs(archive, "900002_maxient-state", 2027):
            failures.append("Maxient shape: a 2027 copy was stored although only the signed logo link changed")
        elif _status(archive, "900002_maxient-state", 2027)["documents"] != maxient_2026:
            failures.append("Maxient shape: 2027 status.json should point at the 2026 document")
        else:
            passed.append("Maxient shape: re-scrape with a new signed logo link stores nothing new")

        if _doc_dirs(archive, "900001_drupal-tech", 2027):
            failures.append("Drupal shape: a 2027 copy was stored although only the random attribute changed")
        else:
            passed.append("Drupal shape: nothing re-stored across years")

        if len(_doc_dirs(archive, "900003_dated-college", 2027)) != 1:
            failures.append("date-only change: a report whose only change is a date MUST be stored as new")
        else:
            passed.append("a report that changed only a date is still stored as a new document")

        # ── PDFs: raw bytes only ──
        known = run.KnownDocuments("archive", "900004_pdf-u")
        h1 = run.store_document("archive", "900004_pdf-u", "900004", 2026, f"{base}/a.pdf",
                                b"%PDF-1.4 hazing report A", True, known)
        h2 = run.store_document("archive", "900004_pdf-u", "900004", 2026, f"{base}/b.pdf",
                                b"%PDF-1.4 hazing report B", True, known)
        h3 = run.store_document("archive", "900004_pdf-u", "900004", 2026, f"{base}/c.pdf",
                                b"%PDF-1.4 hazing report A", True, known)
        if h1 == h2 or h3 != h1 or len(_doc_dirs(archive, "900004_pdf-u", 2026)) != 2:
            failures.append("PDFs: different bytes must both be stored, identical bytes once")
        else:
            passed.append("PDFs still dedupe on raw bytes only")

        # ── Loader: a manifest without sha256 (different schema version) still works ──
        inst = "900002_maxient-state"
        doc = _doc_dirs(archive, inst, 2026)[0]
        real_sha = json.loads((doc / "manifest.json").read_text())["sha256"]
        (doc / "manifest.json").write_text(json.dumps({"schema_version": 2, "cycle_id": "x"}))
        known = run.KnownDocuments.load("archive", inst)
        fresh = run.fetch_url(f"{base}/maxient/chtr.php?MaxientState").content
        fp = run.page_text_fingerprint(run._stored_page_text(fresh))
        if known.match(run.sha256_bytes(fresh), fp) != real_sha:
            failures.append("loader: a manifest without sha256 should still dedupe, returning the stored hash")
        else:
            passed.append("works on manifests of another schema version (no sha256 field)")

        # ── Lazy: a byte-identical capture reads no stored originals ──
        known = run.KnownDocuments.load("archive", inst)
        pending_before = list(known._pending_html)
        original = (doc / "original" / "index.html").read_bytes()
        known.match(run.sha256_bytes(original), "irrelevant")
        if known._pending_html != pending_before or not pending_before:
            failures.append("lazy load: a byte-identical match should not read stored originals")
        else:
            passed.append("a byte-identical capture costs no extra archive reads")

    finally:
        server.shutdown()
        thread.join(timeout=5)
        shutil.rmtree(tmp, ignore_errors=True)
        if prior is None:
            os.environ.pop("ARCHIVE_LOCAL_ROOT", None)
        else:
            os.environ["ARCHIVE_LOCAL_ROOT"] = prior

    if failures:
        print("FAIL")
        for f in failures:
            print(f"      {f}")
        return 1
    for p in passed:
        print(f"ok    {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
