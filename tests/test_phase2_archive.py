"""Phase 2 smoke check: jobs/02-archive/run.py crawled against fixtures/crawl_pages/,
served over a local HTTP server (the crawler does real HTTP fetches; a local server lets
the smoke run exercise the real fetch/keyword/BFS path with no live network).

Asserts: correct archive layout is produced, absence (not_found/no_url) is recorded,
manifest.json/status.json validate against their schemas, a re-run is fully resumable with
zero network calls, and an unchanged document is deduped (not re-stored) across scrape
years. Per IMPLEMENTATION_PLAN.md §16.

Run with: python tests/test_phase2_archive.py
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

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FIXTURES = ROOT / "fixtures" / "crawl_pages"
SCHEMAS = ROOT / "schemas"


def _load_run_module():
    """jobs/02-archive/run.py can't be `import`ed by its hyphenated/digit-leading dir name."""
    spec = importlib.util.spec_from_file_location(
        "job_02_archive_run", ROOT / "jobs" / "02-archive" / "run.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def _start_server(directory: Path) -> tuple[ThreadingHTTPServer, threading.Thread]:
    handler = partial(_QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _write_schools_csv(base_url: str, dest: Path) -> Path:
    template = (FIXTURES / "schools_template.csv").read_text()
    dest.write_text(template.replace("{BASE_URL}", base_url))
    return dest


def _validate_all_json(archive_root: Path) -> list[str]:
    failures = []
    manifest_schema = Draft202012Validator(json.loads((SCHEMAS / "manifest.schema.json").read_text()))
    status_schema = Draft202012Validator(json.loads((SCHEMAS / "status.schema.json").read_text()))
    for path in archive_root.rglob("*.json"):
        doc = json.loads(path.read_text())
        validator = status_schema if path.name == "status.json" else manifest_schema
        errors = list(validator.iter_errors(doc))
        if errors:
            for e in errors:
                failures.append(f"{path.relative_to(archive_root)}: {e.message}")
    return failures


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase2_"))
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
    schools_csv = _write_schools_csv(base_url, tmp_root / "schools.csv")

    try:
        run = _load_run_module()

        fetch_calls: list[str] = []
        real_fetch_url = run.fetch_url

        def counting_fetch_url(url, *a, **kw):
            fetch_calls.append(url)
            return real_fetch_url(url, *a, **kw)

        run.fetch_url = counting_fetch_url

        # ── Run 1: fresh crawl, year 2026 ──────────────────────────────────
        results = run.run(schools_csv=schools_csv, year=2026)
        expected_results = {"published": 3, "not_found": 1, "no_url": 1}
        if results != expected_results:
            failures.append(f"run 1 results: expected {expected_results!r}, got {results!r}")
        if not fetch_calls:
            failures.append("run 1 made no HTTP fetches at all — crawler didn't run")

        archive_root = archive_local_root / "archive"

        def _status(inst_dir: str, year: int = 2026) -> dict:
            return json.loads((archive_root / inst_dir / str(year) / "status.json").read_text())

        nr = _status("200001_north-ridge-college")
        if nr["status"] != "published" or len(nr["documents"]) != 1:
            failures.append(f"north-ridge status.json unexpected: {nr}")

        ev = _status("200002_eastview-university")
        if ev["status"] != "published" or len(ev["documents"]) != 3:
            failures.append(f"eastview status.json unexpected: {ev}")

        wf = _status("200003_westfield-institute")
        if wf["status"] != "published" or len(wf["documents"]) != 1:
            failures.append(f"westfield status.json unexpected: {wf}")
        else:
            wf_hash16 = wf["documents"][0][:16]
            pdf_bytes = (archive_root / "200003_westfield-institute" / "2026" / "docs"
                         / wf_hash16 / "original" / "report.pdf").read_bytes()
            from lib.text import pdf_to_text
            if pdf_to_text(pdf_bytes) != "":
                failures.append("westfield's archived PDF unexpectedly has a text layer")

        cv = _status("200004_centerville-tech")
        if cv["status"] != "not_found" or cv["documents"] != [] or cv["source_url"] is None:
            failures.append(f"centerville status.json unexpected: {cv}")

        nra = _status("200005_no-report-academy")
        if nra["status"] != "no_url" or nra["documents"] != [] or nra["source_url"] is not None:
            failures.append(f"no-report-academy status.json unexpected: {nra}")

        schema_failures = _validate_all_json(archive_root)
        failures += [f"schema: {f}" for f in schema_failures]

        # ── Run 2: same year, resumability — must skip everything, zero fetches ──
        fetch_calls.clear()
        results2 = run.run(schools_csv=schools_csv, year=2026)
        if results2 != {"skipped": 5}:
            failures.append(f"run 2 (resumability) results: expected all skipped, got {results2!r}")
        if fetch_calls:
            failures.append(f"run 2 (resumability) made HTTP fetches, expected none: {fetch_calls}")

        # ── Run 3: new year, unchanged content — dedup, no new docs/ dirs ──
        fetch_calls.clear()
        results3 = run.run(schools_csv=schools_csv, year=2027)
        if results3 != expected_results:
            failures.append(f"run 3 (new year) results: expected {expected_results!r}, got {results3!r}")
        if not fetch_calls:
            failures.append("run 3 (new year) made no HTTP fetches — should re-crawl to check for changes")

        ev_2027 = _status("200002_eastview-university", year=2027)
        if ev_2027["documents"] != ev["documents"]:
            failures.append(
                f"eastview 2027 documents differ from 2026 despite unchanged content: "
                f"{ev_2027['documents']} vs {ev['documents']}"
            )
        docs_dir_2027 = archive_root / "200002_eastview-university" / "2027" / "docs"
        if docs_dir_2027.exists():
            failures.append(
                "eastview 2027 has a docs/ dir — unchanged documents should be deduped, "
                "not re-stored under the new year"
            )

        # ── Run 4: --prefix smoke — the fixtures smoke run must land under smoke/,
        # never mixed into archive/ (IMPLEMENTATION_PLAN.md §14) ──
        fetch_calls.clear()
        results4 = run.run(schools_csv=schools_csv, year=2099, prefix="smoke")
        if results4 != expected_results:
            failures.append(f"run 4 (prefix=smoke) results: expected {expected_results!r}, got {results4!r}")
        smoke_status_path = archive_local_root / "smoke" / "200001_north-ridge-college" / "2099" / "status.json"
        if not smoke_status_path.exists():
            failures.append(f"run 4 (prefix=smoke): expected {smoke_status_path} to exist")
        if (archive_root / "200001_north-ridge-college" / "2099").exists():
            failures.append("run 4 (prefix=smoke): leaked a 2099 dir into archive/ instead of smoke/")

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
    print("ok    run 1: fresh crawl produces correct archive layout, absence recorded")
    print("ok    all written manifest.json/status.json validate against their schemas")
    print("ok    run 2: re-run is fully resumable (skips all, zero HTTP fetches)")
    print("ok    run 3: unchanged document deduped across scrape years")
    print("ok    run 4: --prefix smoke writes under smoke/, never touches archive/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
