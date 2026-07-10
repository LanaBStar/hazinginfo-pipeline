"""
run.py — 03-normalize: produce extracted/text.txt for every document in the archive.

HTML -> text, DOCX -> text, PDF -> text-layer extraction attempt (lib/text.py, built in
Phase 1). No OCR pipeline: a PDF with no text layer yields an empty text.txt, which
downstream (04-extract/validate.py) auto-flags for review since anchoring can't run
against empty text. PDF text includes `[[page N]]` markers so lib/quotes.py's anchoring
can check a quote's page hint.

Idempotent and resumable: a document that already has extracted/text.txt is skipped.

Run: python jobs/03-normalize/run.py [--prefix archive/]
"""
import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from lib import r2  # noqa: E402
from lib.text import docx_to_text, html_to_text, pdf_to_text  # noqa: E402

DEFAULT_PREFIX = "archive/"

DOCX_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def find_doc_dirs(prefix: str) -> tuple[list[str], set[str]]:
    """Doc directories (`{prefix}{inst}/{year}/docs/{hash16}`) that have a manifest.json,
    plus the full key set (reused so callers don't re-list the same prefix)."""
    keys = set(r2.list_keys(prefix))
    doc_dirs = set()
    for key in keys:
        parts = key.split("/")
        if len(parts) >= 5 and parts[3] == "docs" and parts[-1] == "manifest.json":
            doc_dirs.add("/".join(parts[:5]))
    return sorted(doc_dirs), keys


def _original_bytes(doc_dir: str, keys: set[str]) -> bytes:
    prefix = f"{doc_dir}/original/"
    candidates = sorted(k for k in keys if k.startswith(prefix) and "/assets/" not in k)
    if not candidates:
        raise FileNotFoundError(f"no original document found under {prefix}")
    return r2.get_bytes(candidates[0])


def extract_text(content_type: str, content: bytes) -> str:
    if content_type == "application/pdf":
        return pdf_to_text(content)
    if content_type == "text/html":
        return html_to_text(content.decode("utf-8", errors="replace"))
    if content_type in DOCX_CONTENT_TYPES:
        return docx_to_text(content)
    raise ValueError(f"03-normalize: unsupported content_type {content_type!r}")


def normalize_document(doc_dir: str, keys: set[str]) -> None:
    import json
    manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
    content = _original_bytes(doc_dir, keys)
    text = extract_text(manifest["content_type"], content)
    r2.put_bytes(f"{doc_dir}/extracted/text.txt", text.encode("utf-8"))
    if text.strip():
        logging.info(f"  {doc_dir}: extracted {len(text)} chars")
    else:
        logging.info(f"  {doc_dir}: no text layer -- wrote empty text.txt")


def run(prefix: str = DEFAULT_PREFIX) -> dict:
    doc_dirs, keys = find_doc_dirs(prefix)
    results = {"normalized": 0, "skipped": 0, "no_text_layer": 0, "failed": 0}

    for doc_dir in doc_dirs:
        text_key = f"{doc_dir}/extracted/text.txt"
        if text_key in keys:
            results["skipped"] += 1
            continue
        try:
            normalize_document(doc_dir, keys)
        except Exception as e:
            logging.error(f"{doc_dir}: normalize failed -- {e}")
            results["failed"] += 1
            continue
        results["normalized"] += 1
        if not r2.get_bytes(text_key).strip():
            results["no_text_layer"] += 1

    logging.info(f"Normalize run complete: {results}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(prefix=args.prefix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
