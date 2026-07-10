"""
run.py — 02-archive: fetch CHTR originals for every institution with a confirmed URL and
write manifest.json (per document) + status.json (per institution-year) into the archive.

Crawl core is ported from reference/scrape.py + reference/helpers.py (frozen, read-only):
keyword heuristics, breadth-first, depth <= 2, ~30-fetch budget per institution,
same-domain links prioritized, all PDFs on hazing-signal pages followed. That logic is
battle-tested — this file changes only the storage layer (R2 manifest/status.json via
lib/r2.py instead of Postgres rows) and the status vocabulary (see status.schema.json).

No AI runs here. clean-up / relevance is decided later, at 04-extract's is_chtr field —
every document that could plausibly be a CHTR gets archived.

Status vocabulary written by this job (see decisions recorded in BUILD_STATUS.md):
  - "no_url":     sources/schools.csv marks this institution's url_status as "no_url"
                  (no confirmed URL exists at all) - never fetched.
  - "not_found":  a confirmed URL existed but the crawl stored zero documents (covers both
                  fetch failure and "no hazing signal anywhere").
  - "published":  >= 1 document was archived (newly stored or already-archived-from-a-
                  prior-year and deduped).
  "published_zero" is never written here - it requires reading document content (an
  explicit zero-incident statement), which is only knowable at 04-extract time.

Resumable: an institution whose status.json already exists for the current scrape year is
skipped entirely (per IMPLEMENTATION_PLAN.md §7's 02-archive spec).

Run: python jobs/02-archive/run.py [--schools-csv PATH] [--year YYYY]
"""
import argparse
import csv
import json
import logging
import re
import sys
from collections import defaultdict, deque
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import jsonschema
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from lib import r2  # noqa: E402
from lib.fetch import fetch_url, is_pdf_response  # noqa: E402
from lib.hashing import sha256_bytes, short_hash  # noqa: E402
from lib.text import html_to_text  # noqa: E402

SCHEMAS_DIR = ROOT / "schemas"
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
ARCHIVE_PREFIX = "archive"

HAZING_KEYWORDS = ["hazing", "chtr", "transparency report", "hazing incident"]
MAX_DEPTH = 2                     # source page = depth 0
MAX_FETCHES_PER_INSTITUTION = 30  # budget for followed links beyond the source page

_schema_cache: dict[str, dict] = {}


def _load_schema(filename: str) -> dict:
    if filename not in _schema_cache:
        _schema_cache[filename] = json.loads((SCHEMAS_DIR / filename).read_text())
    return _schema_cache[filename]


def _validate(doc: dict, schema_filename: str) -> None:
    jsonschema.validate(doc, _load_schema(schema_filename))


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def scrape_year() -> int:
    import os
    override = os.environ.get("SCRAPE_YEAR")
    return int(override) if override else date.today().year


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]


# ── Link/keyword heuristics (ported from reference/scrape.py) ─────────────────

def _extract_links(html: str, base_url: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href and not href.startswith(("#", "mailto:", "javascript:")):
            links.append({"url": urljoin(base_url, href), "text": a.get_text(strip=True)})
    return links


def _matches_keywords(blob: str) -> bool:
    blob = blob.lower()
    return any(kw in blob for kw in HAZING_KEYWORDS)


def _links_blob(links: list[dict]) -> str:
    return " ".join(l.get("text", "") + " " + l.get("url", "") for l in links)


def _is_pdf_url(url: str) -> bool:
    return urlparse(url).path.lower().endswith(".pdf")


def _domain(url: str) -> str:
    """Registrable domain, e.g. 'albion.edu' — good enough for US institutions."""
    host = urlparse(url).netloc.lower()
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def _candidate_links(links: list[dict], page_has_signal: bool, home_domain: str) -> list[str]:
    """
    Pick which links to follow: keyword-matching links first, then — if the page itself is
    hazing-related — every linked PDF (individual incident PDFs on an index page often have
    link text with no keyword). Within each group the institution's own domain comes first,
    so an external hazing-prevention site can't starve the institution's real report links
    of the fetch budget.
    """
    groups = {(kw, same): [] for kw in (True, False) for same in (True, False)}
    seen: set[str] = set()
    for l in links:
        url = l["url"]
        if url in seen or not url.startswith(("http://", "https://")):
            continue
        seen.add(url)
        same = _domain(url) == home_domain
        if _matches_keywords(l.get("text", "") + " " + url):
            groups[(True, same)].append(url)
        elif page_has_signal and _is_pdf_url(url):
            groups[(False, same)].append(url)
    return groups[(True, True)] + groups[(True, False)] + groups[(False, True)] + groups[(False, False)]


# ── Storage layer (R2 manifest.json / dedup) ───────────────────────────────────

def _existing_hashes(inst_dir: str) -> set[str]:
    """The 16-char doc-dir names already archived for this institution, across every prior
    scrape year (§6 dedup: an unchanged document is never re-stored)."""
    keys = r2.list_keys(f"{ARCHIVE_PREFIX}/{inst_dir}/")
    hashes = set()
    for key in keys:
        parts = key.split("/")
        if len(parts) >= 5 and parts[3] == "docs" and parts[-1] == "manifest.json":
            hashes.add(parts[4])
    return hashes


def store_document(inst_dir: str, unitid: str, year: int, url: str, content: bytes,
                    is_pdf: bool, known_hashes: set[str]) -> str:
    """Stores one document if its content hash isn't already archived for this institution
    (in this year or any prior one). Returns the full sha256 hash either way."""
    content_hash = sha256_bytes(content)
    hash16 = short_hash(content_hash)

    if hash16 in known_hashes:
        logging.info(f"  duplicate — {url} already archived as {hash16}")
        return content_hash

    doc_dir = f"{ARCHIVE_PREFIX}/{inst_dir}/{year}/docs/{hash16}"
    filename = "report.pdf" if is_pdf else "index.html"
    r2.put_bytes(f"{doc_dir}/original/{filename}", content)

    manifest = {
        "schema_version": 1,
        "source_url": url,
        "fetched_at": _now_iso(),
        "sha256": content_hash,
        "content_type": "application/pdf" if is_pdf else "text/html",
        "size_bytes": len(content),
        "unitid": unitid,
        "scrape_year": year,
    }
    _validate(manifest, "manifest.schema.json")
    r2.put_bytes(f"{doc_dir}/manifest.json", json.dumps(manifest, indent=2).encode())
    known_hashes.add(hash16)
    logging.info(f"  stored {doc_dir}")
    return content_hash


def write_status(inst_dir: str, unitid: str, year: int, status: str,
                  source_url: str | None, documents: list[str]) -> None:
    doc = {
        "schema_version": 1,
        "unitid": unitid,
        "scrape_year": year,
        "status": status,
        "source_url": source_url,
        "documents": documents,
        "fetched_at": _now_iso(),
    }
    _validate(doc, "status.schema.json")
    r2.put_bytes(f"{ARCHIVE_PREFIX}/{inst_dir}/{year}/status.json", json.dumps(doc, indent=2).encode())


# ── Crawl ───────────────────────────────────────────────────────────────────────

def _crawl(inst_dir: str, unitid: str, year: int, home_domain: str, initial_links: list[str],
           seen_links: set[str], known_hashes: set[str]) -> list[str]:
    """Breadth-first crawl from the source page's links, bounded by
    MAX_FETCHES_PER_INSTITUTION and MAX_DEPTH. Breadth-first so every direct link is
    fetched before any second-level page consumes budget."""
    queue = deque((url, 1) for url in initial_links)
    stored_hashes = []
    fetches = 0

    while queue and fetches < MAX_FETCHES_PER_INSTITUTION:
        url, depth = queue.popleft()
        if url in seen_links:
            continue
        seen_links.add(url)
        fetches += 1

        resp = fetch_url(url)
        if resp is None:
            continue

        if is_pdf_response(resp, url):
            stored_hashes.append(
                store_document(inst_dir, unitid, year, url, resp.content, True, known_hashes)
            )
            continue

        page_text = html_to_text(resp.text)
        links = _extract_links(resp.text, url)
        text_signal = _matches_keywords(page_text)
        any_signal = text_signal or _matches_keywords(_links_blob(links))

        if text_signal and page_text.strip():
            stored_hashes.append(
                store_document(inst_dir, unitid, year, url, resp.content, False, known_hashes)
            )

        if depth < MAX_DEPTH:
            for link in _candidate_links(links, any_signal, home_domain):
                if link not in seen_links:
                    queue.append((link, depth + 1))

        logging.info(f"  [depth={depth}] {url}: done ({fetches}/{MAX_FETCHES_PER_INSTITUTION} fetches)")

    return stored_hashes


def crawl_institution(inst_dir: str, unitid: str, year: int, source_url: str,
                       known_hashes: set[str]) -> list[str]:
    """Fetch and store all CHTR documents reachable from one institution's source URL.
    Returns the list of content hashes stored or found already archived (empty = nothing
    found: fetch failed, or no hazing signal anywhere)."""
    resp = fetch_url(source_url)
    if resp is None:
        return []

    if is_pdf_response(resp, source_url):
        return [store_document(inst_dir, unitid, year, source_url, resp.content, True, known_hashes)]

    page_text = html_to_text(resp.text)
    links = _extract_links(resp.text, source_url)
    text_signal = _matches_keywords(page_text)
    any_signal = text_signal or _matches_keywords(_links_blob(links))

    if not any_signal:
        logging.info("  no hazing signal on page — nothing to store")
        return []

    stored = []
    if text_signal and page_text.strip():
        stored.append(store_document(inst_dir, unitid, year, source_url, resp.content, False, known_hashes))

    home_domain = _domain(source_url)
    seen_links: set[str] = {source_url}
    stored += _crawl(inst_dir, unitid, year, home_domain,
                      _candidate_links(links, any_signal, home_domain), seen_links, known_hashes)
    return stored


# ── Per-institution driver ──────────────────────────────────────────────────────

def process_institution(row: dict, year: int) -> str | None:
    """Returns the outcome ("published" | "not_found" | "no_url" | "skipped"), or None if
    the institution isn't actionable yet (e.g. discover hasn't confirmed a URL)."""
    unitid = row["unitid"]
    name = row["name"]
    url_status = (row.get("url_status") or "").strip()
    chtr_url = (row.get("chtr_url") or "").strip()
    inst_dir = f"{unitid}_{_slug(name)}"
    status_key = f"{ARCHIVE_PREFIX}/{inst_dir}/{year}/status.json"

    if r2.exists(status_key):
        logging.info(f"{name}: status.json already exists for {year} — skipping")
        return "skipped"

    if url_status == "no_url" or not chtr_url:
        if url_status == "no_url":
            write_status(inst_dir, unitid, year, "no_url", None, [])
            return "no_url"
        logging.info(f"{name}: no confirmed URL yet (url_status={url_status!r}) — skipping")
        return None

    if url_status != "confirmed":
        logging.info(f"{name}: url_status={url_status!r} — not yet actionable, skipping")
        return None

    logging.info(f"{name}: crawling {chtr_url}")
    known_hashes = _existing_hashes(inst_dir)
    hashes = crawl_institution(inst_dir, unitid, year, chtr_url, known_hashes)
    documents = list(dict.fromkeys(hashes))  # de-dupe, preserve order

    if documents:
        write_status(inst_dir, unitid, year, "published", chtr_url, documents)
        logging.info(f"  {name}: published ({len(documents)} document(s))")
        return "published"

    write_status(inst_dir, unitid, year, "not_found", chtr_url, [])
    logging.info(f"  {name}: not_found")
    return "not_found"


def run(schools_csv: Path = DEFAULT_SCHOOLS_CSV, year: int | None = None) -> dict:
    year = year or scrape_year()
    if not schools_csv.exists():
        logging.warning(f"{schools_csv} not found — nothing to archive yet "
                         f"(01-discover hasn't produced sources/schools.csv)")
        return {}

    with schools_csv.open(newline="") as f:
        rows = list(csv.DictReader(f))

    results: dict[str, int] = defaultdict(int)
    for row in rows:
        try:
            outcome = process_institution(row, year)
        except Exception as e:
            # A single institution's fetch/crawl failure must not abort the whole run —
            # ~1,484 live university sites means network flakiness is expected.
            logging.error(f"{row.get('name', row.get('unitid'))}: error during archive — {e}")
            try:
                unitid = row["unitid"]
                inst_dir = f"{unitid}_{_slug(row['name'])}"
                chtr_url = (row.get("chtr_url") or "").strip() or None
                write_status(inst_dir, unitid, year, "not_found", chtr_url, [])
                outcome = "not_found"
            except Exception as write_error:
                logging.error(f"  also failed to record not_found status: {write_error}")
                outcome = None
        if outcome:
            results[outcome] += 1

    logging.info(f"Archive run complete: {dict(results)}")
    return dict(results)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schools-csv", type=Path, default=DEFAULT_SCHOOLS_CSV)
    parser.add_argument("--year", type=int, default=None)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(schools_csv=args.schools_csv, year=args.year)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
