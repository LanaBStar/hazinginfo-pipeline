"""Phase 3 smoke check: jobs/03-normalize/run.py.

Builds a real archive by crawling fixtures/crawl_pages/ with 02-archive (same pattern as
test_phase2_archive.py), normalizes it, and asserts: PDF page markers are correct, expected
incident text is present, and the scanned/no-text-layer PDF yields empty text.txt. Also
checks the run is idempotent (a second pass writes nothing new).

v3.0: lib/quotes.py (anchoring) was removed along with the tier system -- this test no
longer exercises it. See tests/test_phase7a_review.py and test_phase14_extract.py for
what replaced it.

Run with: python tests/test_phase3_normalize.py
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


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase3_"))
    archive_local_root = tmp_root / "archive_root"
    archive_local_root.mkdir()

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

        archive_results = archive_run.run(schools_csv=schools_csv, year=2026)
        if archive_results != {"published": 3, "not_found": 1, "no_url": 1}:
            failures.append(f"setup: unexpected archive results {archive_results!r}")

        archive_root = archive_local_root / "archive"

        # ── Normalize run 1 ─────────────────────────────────────────────
        norm_results = normalize_run.run(prefix="archive/")
        # 3 documents total: north-ridge/index.html, westfield/report.pdf,
        # eastview/{index.html, chtr-2025.pdf, decoy-menu.pdf} = 5 documents
        if norm_results["normalized"] != 5 or norm_results["failed"] != 0:
            failures.append(f"normalize run 1: unexpected results {norm_results!r}")
        if norm_results["no_text_layer"] != 1:
            failures.append(
                f"normalize run 1: expected exactly 1 no-text-layer doc (westfield), "
                f"got {norm_results!r}"
            )

        def _status(inst_dir: str) -> dict:
            return json.loads((archive_root / inst_dir / "2026" / "status.json").read_text())

        def _text(inst_dir: str, hash_: str) -> str:
            hash16 = hash_[:16]
            return (archive_root / inst_dir / "2026" / "docs" / hash16
                    / "extracted" / "text.txt").read_text()

        nr = _status("200001_north-ridge-college")
        nr_text = _text("200001_north-ridge-college", nr["documents"][0])
        if "[[page" in nr_text:
            failures.append("north-ridge (HTML) text.txt unexpectedly has page markers")
        if "Sigma Alpha Fraternity" not in nr_text:
            failures.append("north-ridge text.txt missing expected incident text")

        ev = _status("200002_eastview-university")
        ev_texts = {_text("200002_eastview-university", h) for h in ev["documents"]}
        # Both the real CHTR PDF and the decoy PDF are single-page, so both get a
        # "[[page 1]]" marker -- select by expected content, not just the marker.
        pdf_text = next((t for t in ev_texts if "Zeta Psi Fraternity" in t), None)
        if pdf_text is None:
            failures.append("eastview: no document text.txt has the expected incident text")
        elif "[[page 1]]" not in pdf_text:
            failures.append("eastview PDF text.txt missing expected [[page 1]] marker")
        if not any("Dining Services" in t for t in ev_texts):
            failures.append("eastview: decoy menu PDF text.txt missing expected content")

        wf = _status("200003_westfield-institute")
        wf_text = _text("200003_westfield-institute", wf["documents"][0])
        if wf_text != "":
            failures.append(f"westfield (scanned PDF) text.txt should be empty, got {wf_text!r}")

        # ── Normalize run 2: idempotent, nothing new written ─────────────
        norm_results2 = normalize_run.run(prefix="archive/")
        if norm_results2["normalized"] != 0 or norm_results2["skipped"] != 5:
            failures.append(f"normalize run 2 (idempotency): expected all skipped, got {norm_results2!r}")

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
    print("ok    normalize run 1: text.txt written for every document, page markers correct")
    print("ok    scanned/no-text-layer PDF yields empty text.txt")
    print("ok    normalize run 2: idempotent, nothing re-written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
