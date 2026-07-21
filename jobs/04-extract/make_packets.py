"""
make_packets.py -- 04-extract: build one AI task packet per document that has
extracted/text.txt but no current-version extraction yet.

Per IMPLEMENTATION_PLAN.md Section 7. Each packet lives at
tasks/extract/{unitid}_{hash16}/ and contains prompt.md, the original document,
text.txt, schema.json, and a metadata.json stub. The packet dirname (fixed by the
plan) carries only unitid + hash16 -- not the institution slug, scrape_year, or which
extract_v{N} this packet targets -- so the metadata.json stub also carries `doc_dir`
(the full archive path) and `target_version`, snapshotted once at packet-creation
time. validate.py reads those straight back rather than re-deriving them from the
packet dirname or re-scanning archive state (which could race against a second
make_packets run). The agent fills in `model` and `created` when it finishes; the
stub's `doc_dir`/`target_version` are stripped back out before the final metadata.json
is archived (that file must stay compliant with schemas/extract_metadata.schema.json).

Resumable: a document with any existing ai/extract_v*/incidents.json is skipped -- a
new prompt version is a deliberate re-extraction, not something this scan triggers.

Run: python jobs/04-extract/make_packets.py [--prefix archive/] [--tasks-dir tasks/extract/]
"""
import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from lib import r2  # noqa: E402

JOB_DIR = Path(__file__).resolve().parent
DEFAULT_PREFIX = "archive/"
DEFAULT_TASKS_DIR = ROOT / "tasks" / "extract"

# Bumped whenever prompt.md's instructions change meaningfully -- distinct from the
# archive's extract_v{N}, which versions *output*, not the prompt that produced it.
# v2: v3.0 pipeline -- raw+normalized fields, extraction_confidence, flags[], organization
# proposal, determination_status; no more page-anchored quotes.
PROMPT_VERSION = "extract_v2"

ORIGINAL_EXTENSIONS = {
    "application/pdf": ".pdf",
    "text/html": ".html",
}


def find_normalized_doc_dirs(prefix: str) -> tuple[list[str], set[str]]:
    """Doc directories (`{prefix}{inst}/{year}/docs/{hash16}`) that already have
    extracted/text.txt, plus the full key set (reused so callers don't re-list)."""
    keys = set(r2.list_keys(prefix))
    doc_dirs = set()
    for key in keys:
        parts = key.split("/")
        if len(parts) >= 6 and parts[3] == "docs" and parts[-2] == "extracted" and parts[-1] == "text.txt":
            doc_dirs.add("/".join(parts[:5]))
    return sorted(doc_dirs), keys


def existing_extract_versions(doc_dir: str, keys: set[str]) -> list[int]:
    prefix = f"{doc_dir}/ai/extract_v"
    versions = []
    for key in keys:
        if key.startswith(prefix) and key.endswith("/incidents.json"):
            n_str = key[len(prefix):].split("/", 1)[0]
            if n_str.isdigit():
                versions.append(int(n_str))
    return versions


def _original_key(doc_dir: str, keys: set[str]) -> str:
    prefix = f"{doc_dir}/original/"
    candidates = sorted(k for k in keys if k.startswith(prefix) and "/assets/" not in k)
    if not candidates:
        raise FileNotFoundError(f"no original document found under {prefix}")
    return candidates[0]


def make_packet(doc_dir: str, keys: set[str], tasks_dir: Path) -> Path:
    parts = doc_dir.split("/")
    unitid = parts[1].split("_", 1)[0]
    hash16 = parts[4]
    packet_dir = tasks_dir / f"{unitid}_{hash16}"
    packet_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
    content_type = manifest["content_type"]
    ext = ORIGINAL_EXTENSIONS.get(content_type)
    if ext is None:
        raise ValueError(f"04-extract: unsupported content_type {content_type!r} for {doc_dir}")

    original_key = _original_key(doc_dir, keys)
    (packet_dir / f"original{ext}").write_bytes(r2.get_bytes(original_key))
    (packet_dir / "text.txt").write_bytes(r2.get_bytes(f"{doc_dir}/extracted/text.txt"))
    (packet_dir / "schema.json").write_bytes((JOB_DIR / "schema.json").read_bytes())
    (packet_dir / "prompt.md").write_bytes((JOB_DIR / "prompt.md").read_bytes())

    target_version = max(existing_extract_versions(doc_dir, keys), default=0) + 1
    stub = {
        "schema_version": 1,
        "model": None,
        "prompt_version": PROMPT_VERSION,
        "created": None,
        "doc_dir": doc_dir,
        "target_version": target_version,
    }
    (packet_dir / "metadata.json").write_text(json.dumps(stub, indent=2))
    return packet_dir


def run(prefix: str = DEFAULT_PREFIX, tasks_dir: Path = DEFAULT_TASKS_DIR) -> dict:
    doc_dirs, keys = find_normalized_doc_dirs(prefix)
    results = {"packets_created": 0, "skipped": 0, "failed": 0}

    for doc_dir in doc_dirs:
        if existing_extract_versions(doc_dir, keys):
            results["skipped"] += 1
            continue
        try:
            packet_dir = make_packet(doc_dir, keys, tasks_dir)
        except Exception as e:
            logging.error(f"{doc_dir}: packet creation failed -- {e}")
            results["failed"] += 1
            continue
        results["packets_created"] += 1
        logging.info(f"  {doc_dir}: wrote packet {packet_dir}")

    logging.info(f"make_packets run complete: {results}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--tasks-dir", default=str(DEFAULT_TASKS_DIR))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(prefix=args.prefix, tasks_dir=Path(args.tasks_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
