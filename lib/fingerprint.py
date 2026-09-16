"""lib/fingerprint.py — content fingerprinting for the Ledger.

Strips boilerplate/date tokens from fetched text before hashing, so an institution's
annual re-post of the same "no violations found as of <date>" template registers as
unchanged even though the embedded date differs across years. See DATABASE_SCHEMA.md's
Pipeline Logic "Boilerplate/date-token stripping before hashing" entry. Runs
unconditionally on every fetched document, not just ones already known to reuse
boilerplate.

Distinct from manifest.json's sha256, which hashes the raw stored bytes verbatim — that
one exists to prove the archive holds exactly what was fetched, so it must never be
normalized.
"""
import re

from lib.hashing import sha256_bytes

_MONTH_DAY_YEAR_RE = re.compile(
    r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{1,2},?\s+\d{4}\b",
    re.IGNORECASE,
)
_ISO_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_SLASH_DATE_RE = re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b")
_BARE_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_REPORTING_PERIOD_PHRASE_RE = re.compile(
    r"\bthis reporting period\b|\bfor the current reporting period\b", re.IGNORECASE
)
_WHITESPACE_RE = re.compile(r"\s+")

_TOKEN_PATTERNS = (
    _MONTH_DAY_YEAR_RE,
    _ISO_DATE_RE,
    _SLASH_DATE_RE,
    _REPORTING_PERIOD_PHRASE_RE,
    _BARE_YEAR_RE,
)


def strip_boilerplate_tokens(text: str) -> str:
    """Removes date/reporting-period tokens, then collapses whitespace."""
    stripped = text
    for pattern in _TOKEN_PATTERNS:
        stripped = pattern.sub("", stripped)
    return _WHITESPACE_RE.sub(" ", stripped).strip()


def content_fingerprint(text: str) -> str:
    """sha256 hex of the boilerplate-stripped text — Ledger.fingerprint_content_hash."""
    return sha256_bytes(strip_boilerplate_tokens(text).encode("utf-8"))


def page_text_fingerprint(text: str) -> str:
    """sha256 hex of a page's readable text with whitespace collapsed — and NOTHING else
    removed. Used by 02-archive to decide whether a freshly fetched web page is a copy of
    one already stored for the same institution.

    Why not content_fingerprint: that one deletes every date and year before hashing, so
    two versions of a report that differ only in a date — an investigation-concluded date
    filled in, a new incident dated the same as an old one — would hash the same, and the
    newer version would never be stored. That is acceptable for the Ledger's "has this
    changed?" signal and unacceptable for deciding what to keep. Here, any change a reader
    could see produces a different fingerprint.

    Why not the raw sha256: many sites put something in the HTML that changes on every
    request without changing the page. Observed in the 2026-09 four-school run:

      - Georgia Tech (Drupal) writes a random `js-view-dom-id-…` attribute into every
        response, and serves the same listing at both `/hazing-conduct-history` and
        `/hazing-conduct-history?page=0`. Each of its two report pages was stored twice,
        and extraction produced 36 incident rows for 13 incidents.
      - Maxient (cm.maxient.com/chtr.php, 102 schools) loads the school logo through a
        signed Amazon S3 link carrying the request time (`X-Amz-Date=…`). Georgia State's
        page got a new storage folder on every fetch.

    Neither change is in the text, so both collapse to one fingerprint here.
    """
    return sha256_bytes(_WHITESPACE_RE.sub(" ", text).strip().encode("utf-8"))


def url_hash16(url: str) -> str:
    """Stable 16-char id for a URL, used as the ledger/{url_hash16}.json filename — a
    fingerprint of the URL string itself, not its content."""
    return sha256_bytes(url.encode("utf-8"))[:16]
