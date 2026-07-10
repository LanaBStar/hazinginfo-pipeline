"""Derives all pipeline state by walking the archive - never stored, always recomputed
(IMPLEMENTATION_PLAN.md invariant 7). This is the only source of truth the operator
console is allowed to consult; per OPERATIONS.md, every menu render is a fresh call to
this script.

Run: python status.py
"""
import csv
import hashlib
import json
import os
from collections import defaultdict
from datetime import date
from pathlib import Path

from lib import r2

ARCHIVE_PREFIX = "archive/"
SMOKE_PREFIX = "smoke/"
CATALOG_REBUILD_KEY = "catalog/last_rebuild.json"
ROOT = Path(__file__).resolve().parent
SCHOOLS_CSV = ROOT / "sources" / "schools.csv"


def scrape_year() -> int:
    override = os.environ.get("SCRAPE_YEAR")
    return int(override) if override else date.today().year


def read_schools() -> list[dict]:
    if not SCHOOLS_CSV.exists():
        return []
    with SCHOOLS_CSV.open(newline="") as f:
        return list(csv.DictReader(f))


def discover_stats(schools: list[dict]) -> dict:
    return {
        "confirmed_urls": sum(1 for s in schools if s.get("url_status") == "confirmed"),
        "pending_candidates": sum(1 for s in schools if s.get("url_status") == "pending"),
        "no_url": sum(1 for s in schools if s.get("url_status") == "no_url"),
    }


def smoke_run_done(year: int) -> bool:
    return r2.exists(f"{SMOKE_PREFIX}{year}/_DONE")


def last_rebuild() -> str | None:
    if not r2.exists(CATALOG_REBUILD_KEY):
        return None
    return json.loads(r2.get_bytes(CATALOG_REBUILD_KEY))["rebuilt_at"]


def _extract_versions(keys: set[str], doc_dir: str) -> list[str]:
    """Version dir names (e.g. "extract_v1", "extract_v2") that exist under
    {doc_dir}/ai/, oldest first."""
    ai_prefix = f"{doc_dir}/ai/"
    versions = set()
    for key in keys:
        if key.startswith(ai_prefix):
            versions.add(key[len(ai_prefix):].split("/", 1)[0])
    return sorted(versions, key=lambda v: int(v.removeprefix("extract_v")))


def walk_archive(prefix: str, year: int) -> dict:
    """Scans one archive prefix (real `archive/` or the sandboxed `smoke/`) and returns
    every stat derived from it, so the smoke run and the real archive share one code path.
    """
    keys = set(r2.list_keys(prefix))

    institutions_this_year = set()
    doc_dirs = set()
    for key in keys:
        parts = key.split("/")
        if len(parts) < 3:
            continue
        inst_dir, key_year = parts[1], parts[2]
        if parts[3:] == ["status.json"] and key_year == str(year):
            institutions_this_year.add(inst_dir)
        if len(parts) >= 5 and parts[3] == "docs":
            doc_dirs.add("/".join(parts[:5]))

    documents = 0
    pending_normalize = 0
    no_text_layer = 0
    packets_done = 0
    awaiting_validation = 0
    tier_counts = defaultdict(int)
    decided = 0
    approved_unpublished = 0

    for doc_dir in sorted(doc_dirs):
        manifest_key = f"{doc_dir}/manifest.json"
        if manifest_key not in keys:
            continue
        documents += 1

        text_key = f"{doc_dir}/extracted/text.txt"
        if text_key not in keys:
            pending_normalize += 1
        elif not r2.get_bytes(text_key).strip():
            no_text_layer += 1

        versions = _extract_versions(keys, doc_dir)
        if not versions:
            continue
        packets_done += 1

        current = versions[-1]
        version_dir = f"{doc_dir}/ai/{current}"
        incidents_key = f"{version_dir}/incidents.json"
        validation_key = f"{version_dir}/validation.json"
        if incidents_key not in keys:
            continue
        if validation_key not in keys:
            awaiting_validation += 1
            continue

        file_hash = hashlib.sha256(r2.get_bytes(incidents_key)).hexdigest()
        validation = json.loads(r2.get_bytes(validation_key))

        reviews_prefix = f"{doc_dir}/reviews/"
        reviews = [json.loads(r2.get_bytes(k)) for k in keys if k.startswith(reviews_prefix)]

        for incident in validation.get("incidents", []):
            match = next(
                (
                    r for r in reviews
                    if r["extraction_ref"]["file_hash"] == file_hash
                    and r["extraction_ref"]["incident_index"] == incident["index"]
                ),
                None,
            )
            if match is None:
                tier_counts[incident["tier"]] += 1
            else:
                decided += 1
                if match["decision"] in ("approved", "corrected"):
                    approved_unpublished += 1

    return {
        "institutions_done": len(institutions_this_year),
        "documents": documents,
        "pending_normalize": pending_normalize,
        "no_text_layer": no_text_layer,
        "packets_done": packets_done,
        "awaiting_validation": awaiting_validation,
        "tier_counts": dict(tier_counts),
        "decided": decided,
        "approved_unpublished": approved_unpublished,
    }


def build_status() -> dict:
    year = scrape_year()
    schools = read_schools()
    discover = discover_stats(schools)
    archive_facts = walk_archive(ARCHIVE_PREFIX, year)

    pending_archive = max(discover["confirmed_urls"] - archive_facts["institutions_done"], 0)

    return {
        "scrape_year": year,
        "smoke_run": {"done_this_year": smoke_run_done(year)},
        "discover": discover,
        "archive": {
            "institutions_done": archive_facts["institutions_done"],
            "pending": pending_archive,
            "documents": archive_facts["documents"],
        },
        "normalize": {
            "pending_documents": archive_facts["pending_normalize"],
            "no_text_layer": archive_facts["no_text_layer"],
        },
        "extract": {
            "packets_total": archive_facts["documents"],
            "packets_done": archive_facts["packets_done"],
            "awaiting_validation": archive_facts["awaiting_validation"],
        },
        "review": {
            "fast_lane": archive_facts["tier_counts"].get("fast", 0),
            "standard": archive_facts["tier_counts"].get("standard", 0),
            "flagged": archive_facts["tier_counts"].get("flagged", 0),
            "decided": archive_facts["decided"],
        },
        "publish": {
            "last_rebuild": last_rebuild(),
            "approved_unpublished": archive_facts["approved_unpublished"],
        },
    }


def main() -> int:
    print(json.dumps(build_status(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
