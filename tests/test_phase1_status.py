"""Phase 1 smoke check: status.py against a hand-made local mini archive
(fixtures/mini_archive/), with no live R2 credentials. Per IMPLEMENTATION_PLAN.md §16.

Run with: python tests/test_phase1_status.py
"""
import importlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["ARCHIVE_LOCAL_ROOT"] = str(ROOT / "fixtures" / "mini_archive")
os.environ["SCRAPE_YEAR"] = "2026"
for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]:
    # Set to "" rather than popping: dotenv's load_dotenv(override=False) only fills in
    # a var that's absent from os.environ, so once a real .env exists (as of this
    # session) popping would let a real value leak back in on the reload() below.
    # An empty string keeps the key "present" (blocking that) while still being falsy
    # enough to trip lib.r2._require_env's `if not value: raise MissingEnvVar`.
    os.environ[var] = ""

import lib.r2  # noqa: E402  (import-safe with zero credentials, per Phase 1 requirement)
import status  # noqa: E402

EXPECTED = {
    "scrape_year": 2026,
    "smoke_run": {"done_this_year": False},
    "discover": {"confirmed_urls": 0, "pending_candidates": 0, "no_url": 0},
    "archive": {"institutions_done": 4, "pending": 0, "documents": 4},
    "normalize": {"pending_documents": 1, "no_text_layer": 1},
    "extract": {"packets_total": 4, "packets_done": 3, "awaiting_validation": 1},
    "review": {"fast_lane": 1, "standard": 0, "flagged": 1, "decided": 1, "escalated_pending": 0},
    "publish": {"last_rebuild": None, "approved_unpublished": 1},
}


def check_status() -> list[str]:
    importlib.reload(status)
    actual = status.build_status()
    failures = []
    if actual != EXPECTED:
        for key in EXPECTED:
            if actual.get(key) != EXPECTED[key]:
                failures.append(f"status.{key}: expected {EXPECTED[key]!r}, got {actual.get(key)!r}")
    return failures


def check_lib_imports_without_creds() -> list[str]:
    """lib.r2 must be import-safe without credentials; only a real R2 call may fail."""
    failures = []
    try:
        importlib.reload(lib.r2)
    except Exception as e:
        failures.append(f"lib.r2 import raised with no credentials set: {e!r}")
    try:
        lib.r2._get_client()
    except lib.r2.MissingEnvVar:
        pass
    else:
        failures.append("lib.r2._get_client() should have raised MissingEnvVar with no R2_* env vars set")
    return failures


def check_lib_text_and_hashing() -> list[str]:
    from lib import hashing, text

    failures = []
    if hashing.sha256_bytes(b"abc") != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad":
        failures.append("hashing.sha256_bytes(b'abc') did not match the known SHA-256 digest")
    if hashing.short_hash("abcdef0123456789ffff") != "abcdef0123456789":
        failures.append("hashing.short_hash did not truncate to 16 chars")
    if text.html_to_text("<html><body><main>Hello <b>world</b></main></body></html>") != "Hello\nworld":
        failures.append("text.html_to_text did not extract the <main> text as expected")
    return failures


def main() -> int:
    failures = []
    failures += check_status()
    failures += check_lib_imports_without_creds()
    failures += check_lib_text_and_hashing()

    if failures:
        print("FAIL")
        for f in failures:
            print(f"      {f}")
        return 1
    print("ok    status.py matches expected JSON against fixtures/mini_archive/")
    print("ok    lib/r2.py is import-safe with no credentials")
    print("ok    lib/hashing.py, lib/text.py basic checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
