"""
run.py — 02-archive: fetch CHTR originals for every institution with a confirmed URL and
write manifest.json (per document) + status.json (per institution-year) into the archive.

Crawl core is ported from reference/scrape.py + reference/helpers.py (frozen, read-only):
keyword heuristics, breadth-first, depth <= 2, ~30-fetch budget per institution,
same-domain links prioritized. That logic is battle-tested — this file changes only the
storage layer (R2 manifest/status.json via lib/r2.py instead of Postgres rows), the status
vocabulary (see status.schema.json), and the off-domain link rule described below.

OFF-DOMAIN LINK RULE
--------------------
Previously any keyword-matching link was followed regardless of domain, and pages reached
that way were crawled onward like any other. On a live archive of 1,483 institutions that
produced 6,367 stored documents of which 3,331 (52%) sat on domains shared across many
schools — i.e. nobody's own site. stophazing.org alone accounted for 1,539 documents across
188 institutions; hazingpreventionnetwork.org for 825 across 100.

The failure was not stepping off-domain once. It was *continuing to crawl after stepping
off*: an institution's fetch budget was spent walking an advocacy site's own internal link
tree. Alabama A&M (100654) hit the 30-fetch ceiling exactly, with 27 of its 30 stored
documents coming from two advocacy sites and one from aamu.edu — so its actual report may
never have been reached at all. 44 institutions hit that ceiling.

The rule now:

  - On the institution's own domain: unchanged. Breadth-first, depth <= 2, keyword links
    first, all PDFs on a hazing-signal page followed.
  - Off the institution's domain: a link is followed only when it appears on the source
    page itself, only when it is a PDF, a link claiming to be a transparency report, or an
    .edu page mentioning hazing; at most MAX_OFFDOMAIN_LEADS of them; and the page it leads
    to is never crawled onward.

One hop, no expansion. Off-domain has to stay reachable because chtr_index_url is an index
page by design — 37 documents at 35 institutions are transparency reports on third-party
platforms, and cm.maxient.com/chtr.php alone appears for 102 schools, Georgia State among
them. What changes is that no off-domain page can ever consume more than one fetch, which
makes the Alabama A&M failure structurally impossible while leaving real documents
reachable.

Same-domain candidates are enqueued ahead of off-domain leads, so the institution's own
pages always get first claim on the budget.

No AI runs here. Relevance is still decided later, at 04-extract's is_chtr field — this
rule is about not following other people's websites, not about judging page content.

DUPLICATE CAPTURES
------------------
A document is stored once per institution. A PDF counts as already stored when its raw
bytes match a stored document. A web page counts as already stored when its raw bytes
match OR its readable text matches (lib/fingerprint.page_text_fingerprint).

The text test exists because many sites change their HTML on every request without
changing the page. In the 2026-09 four-school run, Georgia Tech's two report pages were
each stored twice (a random Drupal attribute, plus the same listing served with and
without ?page=0) — 36 extracted incident rows for 13 real incidents — and Maxient's page
got a new folder on every fetch because its logo link carries a signed timestamp. That
affects every one of the 102 Maxient schools on every re-scrape.

What is kept is the FIRST capture's bytes; later captures with the same text are recorded
in the Ledger (every URL still gets its entry) but not stored again, and status.json lists
the stored document's hash. The text fingerprint removes nothing but whitespace, so a
report that changed in any visible way — including only a date — is still stored as new.

Stored documents' text fingerprints are not saved anywhere; they are recomputed from
original/ the first time a new web page's bytes are unrecognised, and only then, so an
institution whose pages are byte-stable costs no extra reads.

Status vocabulary written by this job:
  - "no_url":     sources/schools.csv marks this institution's url_status as "no_url"
                  (no confirmed URL exists at all) - never fetched.
  - "not_found":  a confirmed URL existed but the crawl stored zero documents (covers both
                  fetch failure and "no hazing signal anywhere").
  - "published":  >= 1 document was archived (newly stored or already-archived-from-a-
                  prior-year and deduped).
  "published_zero" is never written here - it requires reading document content (an
  explicit zero-incident statement), which is only knowable at 04-extract time.

Resumable: an institution whose status.json already exists for the current scrape year is
skipped entirely.

--prefix defaults to "archive" (the real archive) but, like every other job's --prefix
flag (03-normalize, 04-extract/make_packets.py, 06-publish/rebuild.py), can be pointed at
"smoke" instead — this is what makes the annual pass's mandatory first step (the fixtures
smoke run into a sandboxed smoke/ prefix) possible without mixing smoke and real archive
data in the same live R2 bucket.

Run: python jobs/02-archive/run.py [--schools-csv PATH] [--year YYYY] [--prefix archive]
"""
import argparse
import csv
import json
import logging
import re
import sys
import uuid
from collections import defaultdict, deque
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import jsonschema
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from lib import r2  # noqa: E402
from lib.fetch import fetch_url, is_pdf_response, normalize_url  # noqa: E402
from lib.fingerprint import content_fingerprint, page_text_fingerprint, url_hash16  # noqa: E402
from lib.hashing import sha256_bytes, short_hash  # noqa: E402
from lib.text import html_to_text  # noqa: E402

SCHEMAS_DIR = ROOT / "schemas"
DEFAULT_SCHOOLS_CSV = ROOT / "sources" / "schools.csv"
ARCHIVE_PREFIX = "archive"

HAZING_KEYWORDS = ["hazing", "chtr", "transparency report", "hazing incident"]

# A link carrying one of these is claiming to BE a transparency report, not merely to
# mention hazing. Off-domain that distinction is what separates a school's report hosted
# on a third-party platform from an advocacy site's page about hazing in general.
CHTR_SIGNALS = ["chtr", "transparency report", "transparency-report",
                "transparency_report", "transparencyreport"]
MAX_DEPTH = 2                     # source page = depth 0
MAX_FETCHES_PER_INSTITUTION = 30  # budget for followed links beyond the source page
MAX_OFFDOMAIN_LEADS = 15          # off-domain documents followed from the source page, never expanded

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


def _matches_chtr_signal(blob: str) -> bool:
    """Does this link claim to be a transparency report, rather than merely mention hazing?"""
    blob = blob.lower()
    return any(sig in blob for sig in CHTR_SIGNALS)


def _links_blob(links: list[dict]) -> str:
    return " ".join(l.get("text", "") + " " + l.get("url", "") for l in links)


def _is_pdf_url(url: str) -> bool:
    return urlparse(url).path.lower().endswith(".pdf")


def _domain(url: str) -> str:
    """Registrable domain, e.g. 'albion.edu' — good enough for US institutions."""
    host = urlparse(url).netloc.lower()
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


# An email address written into an href WITHOUT a mailto: scheme. Browsers and urljoin
# both resolve it as a relative path, producing a URL that cannot exist. Observed:
# McNeese's hazing-education page links studentservices@mcneese.edu bare, which resolved
# to https://www.mcneese.edu/campus-life/hazinged/studentservices@mcneese.edu and was then
# followed — because "hazing" is a substring of "hazinged" in that path, it passed the
# keyword test on the URL alone. Three fetches and six seconds of retry backoff per
# occurrence, for a page guaranteed to 404. Common enough in .edu templates (a contact
# address sitting next to the report it is about) to be worth excluding by shape.
_BARE_EMAIL_PATH = re.compile(r"/[^/@\s]+@[^/@\s]+\.[A-Za-z]{2,}/?$")


def _usable_links(links: list[dict]) -> list[dict]:
    """Deduplicated http(s) links, in page order, minus un-schemed email addresses."""
    seen: set[str] = set()
    out = []
    for l in links:
        url = l["url"]
        if url in seen or not url.startswith(("http://", "https://")):
            continue
        seen.add(url)
        if _BARE_EMAIL_PATH.search(urlparse(url).path):
            continue
        out.append({"url": normalize_url(url), "text": l.get("text", "")})
    return out


def _candidate_links(links: list[dict], page_has_signal: bool, home_domain: str) -> list[str]:
    """
    Which links ON THE INSTITUTION'S OWN DOMAIN to follow: keyword-matching links first,
    then — if the page itself is hazing-related — every linked PDF (individual incident
    PDFs on an index page often have link text with no keyword).

    Off-domain links are deliberately not returned here; see _offdomain_leads. Splitting
    the two is what stops an institution's fetch budget being spent on somebody else's
    website, which is the failure this rule exists to prevent.
    """
    keyword_hits, pdf_hits = [], []
    for l in _usable_links(links):
        url = l["url"]
        if _domain(url) != home_domain:
            continue
        if _matches_keywords(l.get("text", "") + " " + url):
            keyword_hits.append(url)
        elif page_has_signal and _is_pdf_url(url):
            pdf_hits.append(url)
    return keyword_hits + pdf_hits


def _offdomain_leads(links: list[dict], page_has_signal: bool, home_domain: str) -> list[str]:
    """
    Off-domain documents worth exactly one fetch each, from the source page only.

    chtr_index_url is an index page by design: a school either lists its incidents on it or
    links out to them, so the documents this job exists to collect are frequently NOT on the
    school's own domain. Measured across the live archive, 37 documents at 35 institutions
    are transparency reports hosted on third-party platforms, and cm.maxient.com/chtr.php
    appears for 102 schools — Georgia State's own report is there, and its recorded index
    page links to it rather than listing incidents. Refusing every off-domain link would
    lose all of them.

    Three kinds qualify, in priority order:

      1. A PDF, on any domain. A PDF is a document wherever it is parked; svdcdn.com,
         pcdn.co, amazonaws.com, sharepoint.com and dropbox.com were all observed holding
         schools' documents.
      2. A link claiming to BE a transparency report — 'chtr' or 'transparency report' in
         its URL or link text. This is what reaches cm.maxient.com/chtr.php while still
         excluding cm.maxient.com/reportingform.php: a reporting form is the data check
         system's concern, not this job's.
      3. An HTML page on another .edu whose link mentions hazing — university system
         offices (ulsystem.edu was observed publishing for a member campus) and schools
         mid-rebrand (uno.edu now redirects to lsuneworleans.edu).

    Everything else off-domain is excluded, which removes every large source of junk
    measured in the archive: stophazing.org (1,539 documents across 188 schools),
    hazingpreventionnetwork.org (825 across 100), clerycenter.org, insidehazing.com,
    antihazingcoalition.org, congress.gov, the state legislature sites and Google Docs.

    Campus subdomains are unaffected — _domain() reduces hunter.cuny.edu to cuny.edu, so
    they were never off-domain to begin with.

    The ordering matters once the cap bites: actual documents should claim it ahead of .edu
    pages that merely mention hazing.
    """
    pdf_hits, chtr_hits, edu_hits = [], [], []
    for l in _usable_links(links):
        url = l["url"]
        blob = l.get("text", "") + " " + url
        domain = _domain(url)
        if domain == home_domain:
            continue
        if page_has_signal and _is_pdf_url(url):
            pdf_hits.append(url)
        elif _matches_chtr_signal(blob):
            chtr_hits.append(url)
        elif domain.endswith(".edu") and _matches_keywords(blob):
            edu_hits.append(url)
    return (pdf_hits + chtr_hits + edu_hits)[:MAX_OFFDOMAIN_LEADS]


# ── Storage layer (R2 manifest.json / dedup) ───────────────────────────────────

def _stored_page_text(content: bytes) -> str:
    """A web page's readable text, derived from its raw bytes exactly as 03-normalize
    derives extracted/text.txt. Used only for the duplicate test, so that a page fetched
    today and a page read back out of the archive are compared the same way."""
    return html_to_text(content.decode("utf-8", errors="replace"))


class KnownDocuments:
    """What is already archived for one institution, across every scrape year, keyed two
    ways: by doc-dir name (raw-bytes hash) and — for web pages — by readable-text
    fingerprint. Both map to the stored document's full sha256, which is what status.json
    lists. See DUPLICATE CAPTURES in the module docstring.

    Text fingerprints of documents stored in EARLIER runs are loaded lazily, on the first
    lookup that needs them."""

    def __init__(self, prefix: str, inst_dir: str, by_hash16: dict[str, str] | None = None,
                 html_doc_dirs: list[str] | None = None):
        self.prefix = prefix
        self.inst_dir = inst_dir
        self.by_hash16: dict[str, str] = dict(by_hash16 or {})
        self.by_text: dict[str, str] = {}
        self._pending_html = list(html_doc_dirs or [])

    @classmethod
    def load(cls, prefix: str, inst_dir: str) -> "KnownDocuments":
        """Reads only the key listing plus each manifest's sha256. Which documents are web
        pages is decided by the presence of original/index.html, not by manifest fields,
        so this works whatever manifest schema version wrote the archive."""
        keys = set(r2.list_keys(f"{prefix}/{inst_dir}/"))
        by_hash16, html_doc_dirs = {}, []
        for key in sorted(keys):
            parts = key.split("/")
            if len(parts) >= 5 and parts[3] == "docs" and parts[-1] == "manifest.json":
                doc_dir = "/".join(parts[:5])
                try:
                    sha = json.loads(r2.get_bytes(key).decode("utf-8")).get("sha256")
                except Exception as e:
                    logging.warning(f"  unreadable manifest {key}: {e}")
                    sha = None
                by_hash16[parts[4]] = sha
                if f"{doc_dir}/original/index.html" in keys:
                    html_doc_dirs.append(doc_dir)
        return cls(prefix, inst_dir, by_hash16, html_doc_dirs)

    def _load_text_fingerprints(self) -> None:
        while self._pending_html:
            doc_dir = self._pending_html.pop(0)
            try:
                content = r2.get_bytes(f"{doc_dir}/original/index.html")
            except Exception as e:
                logging.warning(f"  could not read {doc_dir}/original/index.html for the duplicate test: {e}")
                continue
            text = _stored_page_text(content)
            if text.strip():
                # The stored bytes are right here, so the full hash is recomputable even
                # when the manifest didn't give it.
                self.by_text.setdefault(page_text_fingerprint(text), sha256_bytes(content))

    def match(self, content_hash: str, text_fp: str | None) -> str | None:
        """The stored document's sha256 if this capture is a copy of it, else None."""
        hash16 = short_hash(content_hash)
        if hash16 in self.by_hash16:
            return self.by_hash16[hash16] or content_hash
        if text_fp is None:
            return None
        self._load_text_fingerprints()
        return self.by_text.get(text_fp)

    def add(self, content_hash: str, text_fp: str | None) -> None:
        self.by_hash16[short_hash(content_hash)] = content_hash
        if text_fp is not None:
            self.by_text.setdefault(text_fp, content_hash)


def store_document(prefix: str, inst_dir: str, unitid: str, year: int, url: str, content: bytes,
                    is_pdf: bool, known: KnownDocuments, fetched_text: str | None = None) -> str:
    """Stores one document unless it is already archived for this institution (in this
    year or any prior one) — same raw bytes, or, for a web page, the same readable text.
    Returns the sha256 of the document as stored: this capture's own hash if it was stored
    or matched byte-for-byte, the earlier capture's hash if it matched on text only.

    Also writes/updates this URL's Ledger entry (v3.0), independent of the storage/dedup
    decision below — the Ledger tracks every URL ever seen. fetched_text is the page's
    plain text for boilerplate-stripped fingerprinting (HTML only); None for PDFs, which
    fall back to the raw content_hash as their fingerprint."""
    content_hash = sha256_bytes(content)
    hash16 = short_hash(content_hash)
    write_ledger_entry(prefix, inst_dir, unitid, url, fetched_text, content_hash)

    text_fp = None
    if not is_pdf:
        stored_text = _stored_page_text(content)
        if stored_text.strip():
            text_fp = page_text_fingerprint(stored_text)

    existing = known.match(content_hash, text_fp)
    if existing == content_hash:
        logging.info(f"  duplicate — {url} already archived as {hash16}")
        return content_hash
    if existing:
        logging.info(f"  duplicate — {url} has the same text as {short_hash(existing)} "
                     f"(bytes differ only outside the readable page); not stored again")
        return existing

    doc_dir = f"{prefix}/{inst_dir}/{year}/docs/{hash16}"
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
    known.add(content_hash, text_fp)
    logging.info(f"  stored {doc_dir}")
    return content_hash


def write_status(prefix: str, inst_dir: str, unitid: str, year: int, status: str,
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
    r2.put_bytes(f"{prefix}/{inst_dir}/{year}/status.json", json.dumps(doc, indent=2).encode())


# ── Ledger / Data_checks / Pipeline-runs (v3.0) ─────────────────────────────────

def write_ledger_entry(prefix: str, inst_dir: str, unitid: str, url: str, fetched_text: str | None,
                        content_hash: str) -> None:
    """One entry per distinct URL, across scrape years. Updated in place on a re-seen URL
    (the one archive file exempt from the append-only rule — it's dedup bookkeeping,
    not archived content). fetched_text is the page's plain text for boilerplate/date-token
    stripping (HTML); pass None for PDFs, where run.py has no text layer available yet
    (03-normalize's job) and the raw content_hash is used as the fingerprint instead."""
    key = f"{prefix}/{inst_dir}/ledger/{url_hash16(url)}.json"
    now = _now_iso()
    fingerprint = content_fingerprint(fetched_text) if fetched_text is not None else content_hash

    existing = None
    if r2.exists(key):
        existing = json.loads(r2.get_bytes(key).decode("utf-8"))

    entry = {
        "schema_version": 1,
        "unitid": unitid,
        "source_url": url,
        "fingerprint_content_hash": fingerprint,
        "first_seen_date": existing["first_seen_date"] if existing else now,
        "last_seen_date": now,
    }
    _validate(entry, "ledger_entry.schema.json")
    r2.put_bytes(key, json.dumps(entry, indent=2).encode())


def _load_airtable_cross_check(tasks_dir: Path) -> dict[str, dict]:
    """{unitid: {matched, airtable_url}}, or {} if import_airtable.py hasn't run this
    cycle yet -- an institution simply gets airtable_cross_check: null in that case."""
    path = tasks_dir / "discover" / "airtable_cross_check.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text()).get("results", {})


def write_data_check(prefix: str, inst_dir: str, unitid: str, year: int, chtr_index_url: str | None,
                      pipeline_status: str, pipeline_run_id: str,
                      airtable_cross_check: dict[str, dict] | None = None) -> None:
    """One per institution per scrape cycle, written unconditionally regardless of outcome.
    checked_by is a placeholder (there's no real per-checker identity flowing through the
    pipeline yet). airtable_cross_check comes from import_airtable.py's output, keyed by
    unitid — null if that hasn't run this cycle, or this institution has no confirmed URL
    to cross-check yet. pipeline_run_id is the id of the batch run that (re)processed this
    institution this cycle — RE-POINTABLE, NOT FROZEN: a retry of a Partial/Error row
    overwrites this field with the later run's id, since this row is updated in place, not
    recreated per attempt (contrast Artifacts.pipeline_run_id, frozen at artifact
    creation). Required per DATABASE_SCHEMA.md's Data_checks.pipeline_run_id FK."""
    doc = {
        "schema_version": 1,
        "unitid": unitid,
        "scrape_year": year,
        "pipeline_run_id": pipeline_run_id,
        "chtr_index_url": chtr_index_url,
        "checked_by": "01-discover-agent",
        "data_check_date": date.today().isoformat(),
        "pipeline_status": pipeline_status,
        "airtable_cross_check": (airtable_cross_check or {}).get(unitid),
    }
    _validate(doc, "data_check.schema.json")
    r2.put_bytes(f"{prefix}/{inst_dir}/{year}/data_check.json", json.dumps(doc, indent=2).encode())


def start_pipeline_run(prompt_version: str = "n/a") -> str:
    """Writes a 'Running' pipeline_runs/{run_id}.json at the start of a batch run. Not
    institution-scoped, so it lives at the archive root, not under archive/."""
    run_id = f"run_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"
    doc = {
        "schema_version": 1,
        "run_id": run_id,
        "prompt_version": prompt_version,
        "run_status": "Running",
        "run_started_at": _now_iso(),
        "run_completed_at": None,
    }
    _validate(doc, "pipeline_run.schema.json")
    r2.put_bytes(f"pipeline_runs/{run_id}.json", json.dumps(doc, indent=2).encode())
    return run_id


def complete_pipeline_run(run_id: str, run_status: str, prompt_version: str = "n/a") -> None:
    doc = {
        "schema_version": 1,
        "run_id": run_id,
        "prompt_version": prompt_version,
        "run_status": run_status,
        "run_started_at": json.loads(r2.get_bytes(f"pipeline_runs/{run_id}.json").decode())["run_started_at"],
        "run_completed_at": _now_iso(),
    }
    _validate(doc, "pipeline_run.schema.json")
    r2.put_bytes(f"pipeline_runs/{run_id}.json", json.dumps(doc, indent=2).encode())


# ── Crawl ───────────────────────────────────────────────────────────────────────

def _crawl(prefix: str, inst_dir: str, unitid: str, year: int, home_domain: str,
           queue: deque, seen_links: set[str], known: KnownDocuments) -> list[str]:
    """Breadth-first crawl, bounded by MAX_FETCHES_PER_INSTITUTION and MAX_DEPTH.
    Breadth-first so every direct link is fetched before any second-level page consumes
    budget.

    Queue items are (url, depth, expand). expand=False marks an off-domain lead: it is
    fetched and stored like anything else, but its own links are never followed. That is
    the whole of the off-domain rule — one hop, no expansion — and it is what stops an
    institution's budget being spent inside somebody else's website."""
    stored_hashes = []
    fetches = 0

    while queue and fetches < MAX_FETCHES_PER_INSTITUTION:
        url, depth, expand = queue.popleft()
        if url in seen_links:
            continue
        seen_links.add(url)
        fetches += 1

        resp = fetch_url(url)
        if resp is None:
            continue

        if is_pdf_response(resp, url):
            stored_hashes.append(
                store_document(prefix, inst_dir, unitid, year, url, resp.content, True, known)
            )
            continue

        page_text = html_to_text(resp.text)
        links = _extract_links(resp.text, url)
        text_signal = _matches_keywords(page_text)
        any_signal = text_signal or _matches_keywords(_links_blob(links))

        if text_signal and page_text.strip():
            stored_hashes.append(
                store_document(prefix, inst_dir, unitid, year, url, resp.content, False, known,
                                fetched_text=page_text)
            )

        if not expand:
            logging.info(f"  [depth={depth}] {url}: off-domain lead, not expanded "
                          f"({fetches}/{MAX_FETCHES_PER_INSTITUTION} fetches)")
            continue

        if depth < MAX_DEPTH:
            for link in _candidate_links(links, any_signal, home_domain):
                if link not in seen_links:
                    queue.append((link, depth + 1, True))

        logging.info(f"  [depth={depth}] {url}: done ({fetches}/{MAX_FETCHES_PER_INSTITUTION} fetches)")

    return stored_hashes


def crawl_institution(prefix: str, inst_dir: str, unitid: str, year: int, source_url: str,
                       known: KnownDocuments) -> list[str]:
    """Fetch and store all CHTR documents reachable from one institution's source URL.
    Returns the list of content hashes stored or found already archived (empty = nothing
    found: fetch failed, or no hazing signal anywhere).

    Off-domain leads are taken from the source page only, and are queued after every
    same-domain candidate so the institution's own pages always get first claim on the
    fetch budget."""
    resp = fetch_url(source_url)
    if resp is None:
        return []

    if is_pdf_response(resp, source_url):
        return [store_document(prefix, inst_dir, unitid, year, source_url, resp.content, True, known)]

    page_text = html_to_text(resp.text)
    links = _extract_links(resp.text, source_url)
    text_signal = _matches_keywords(page_text)
    any_signal = text_signal or _matches_keywords(_links_blob(links))

    if not any_signal:
        logging.info("  no hazing signal on page — nothing to store")
        return []

    stored = []
    if text_signal and page_text.strip():
        stored.append(store_document(prefix, inst_dir, unitid, year, source_url, resp.content, False, known,
                                      fetched_text=page_text))

    home_domain = _domain(source_url)
    seen_links: set[str] = {source_url}

    same_domain = _candidate_links(links, any_signal, home_domain)
    off_domain = _offdomain_leads(links, any_signal, home_domain)
    if off_domain:
        logging.info(f"  {len(off_domain)} off-domain lead(s) queued, one fetch each: "
                      f"{', '.join(sorted({_domain(u) for u in off_domain}))}")

    queue = deque([(url, 1, True) for url in same_domain] +
                   [(url, 1, False) for url in off_domain])

    stored += _crawl(prefix, inst_dir, unitid, year, home_domain, queue, seen_links, known)
    return stored


# ── Per-institution driver ──────────────────────────────────────────────────────

def process_institution(prefix: str, row: dict, year: int, pipeline_run_id: str,
                         airtable_cross_check: dict[str, dict]) -> str | None:
    """Returns the outcome ("published" | "not_found" | "no_url" | "skipped"), or None if
    the institution isn't actionable yet (e.g. discover hasn't confirmed a URL). Writes a
    data_check.json every time this institution is actually processed this cycle --
    unconditionally, regardless of outcome, mirroring status.json's own
    "absence is data" treatment."""
    unitid = row["unitid"]
    name = row["name"]
    url_status = (row.get("url_status") or "").strip()
    chtr_url = (row.get("chtr_url") or "").strip()
    inst_dir = f"{unitid}_{_slug(name)}"
    status_key = f"{prefix}/{inst_dir}/{year}/status.json"

    if r2.exists(status_key):
        logging.info(f"{name}: status.json already exists for {year} — skipping")
        return "skipped"

    if url_status == "no_url" or not chtr_url:
        if url_status == "no_url":
            write_status(prefix, inst_dir, unitid, year, "no_url", None, [])
            write_data_check(prefix, inst_dir, unitid, year, None, "Complete", pipeline_run_id,
                              airtable_cross_check)
            return "no_url"
        logging.info(f"{name}: no confirmed URL yet (url_status={url_status!r}) — skipping")
        write_data_check(prefix, inst_dir, unitid, year, None, "Awaiting processing", pipeline_run_id,
                          airtable_cross_check)
        return None

    if url_status != "confirmed":
        logging.info(f"{name}: url_status={url_status!r} — not yet actionable, skipping")
        write_data_check(prefix, inst_dir, unitid, year, None, "Awaiting processing", pipeline_run_id,
                          airtable_cross_check)
        return None

    logging.info(f"{name}: crawling {chtr_url}")
    known = KnownDocuments.load(prefix, inst_dir)
    hashes = crawl_institution(prefix, inst_dir, unitid, year, chtr_url, known)
    documents = list(dict.fromkeys(hashes))  # de-dupe, preserve order

    if documents:
        write_status(prefix, inst_dir, unitid, year, "published", chtr_url, documents)
        write_data_check(prefix, inst_dir, unitid, year, chtr_url, "Complete", pipeline_run_id,
                          airtable_cross_check)
        logging.info(f"  {name}: published ({len(documents)} document(s))")
        return "published"

    write_status(prefix, inst_dir, unitid, year, "not_found", chtr_url, [])
    write_data_check(prefix, inst_dir, unitid, year, chtr_url, "Complete", pipeline_run_id, airtable_cross_check)
    logging.info(f"  {name}: not_found")
    return "not_found"


def run(schools_csv: Path = DEFAULT_SCHOOLS_CSV, year: int | None = None, prefix: str = ARCHIVE_PREFIX) -> dict:
    year = year or scrape_year()
    if not schools_csv.exists():
        logging.warning(f"{schools_csv} not found — nothing to archive yet "
                         f"(01-discover hasn't produced sources/schools.csv)")
        return {}

    with schools_csv.open(newline="") as f:
        rows = list(csv.DictReader(f))

    airtable_cross_check = _load_airtable_cross_check(ROOT / "tasks")
    pipeline_run_id = start_pipeline_run()
    had_failure = False
    results: dict[str, int] = defaultdict(int)
    for row in rows:
        try:
            outcome = process_institution(prefix, row, year, pipeline_run_id, airtable_cross_check)
        except Exception as e:
            # A single institution's fetch/crawl failure must not abort the whole run —
            # ~1,484 live university sites means network flakiness is expected.
            had_failure = True
            logging.error(f"{row.get('name', row.get('unitid'))}: error during archive — {e}")
            try:
                unitid = row["unitid"]
                inst_dir = f"{unitid}_{_slug(row['name'])}"
                chtr_url = (row.get("chtr_url") or "").strip() or None
                write_status(prefix, inst_dir, unitid, year, "not_found", chtr_url, [])
                write_data_check(prefix, inst_dir, unitid, year, chtr_url, "Partial/Error", pipeline_run_id,
                                  airtable_cross_check)
                outcome = "not_found"
            except Exception as write_error:
                logging.error(f"  also failed to record not_found status: {write_error}")
                outcome = None
        if outcome:
            results[outcome] += 1

    complete_pipeline_run(pipeline_run_id, "Partial-Error" if had_failure else "Complete")
    logging.info(f"Archive run complete: {dict(results)}")
    return dict(results)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schools-csv", type=Path, default=DEFAULT_SCHOOLS_CSV)
    parser.add_argument("--year", type=int, default=None)
    parser.add_argument("--prefix", default=ARCHIVE_PREFIX)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    run(schools_csv=args.schools_csv, year=args.year, prefix=args.prefix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
