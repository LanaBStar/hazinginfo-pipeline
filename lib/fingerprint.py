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


def url_hash16(url: str) -> str:
    """Stable 16-char id for a URL, used as the ledger/{url_hash16}.json filename — a
    fingerprint of the URL string itself, not its content."""
    return sha256_bytes(url.encode("utf-8"))[:16]
