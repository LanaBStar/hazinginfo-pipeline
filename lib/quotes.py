"""Anchoring: verifies an AI-extracted quote is really present in a document's extracted
text (IMPLEMENTATION_PLAN.md invariant 5, §9). Whitespace is normalized before matching
(PDF text extraction and HTML-to-text both reflow line breaks); the ~95% similarity
threshold and page-marker check are per §9. Output shape mirrors
schemas/validation.schema.json's `anchor_result` exactly, since 04-extract's validate.py
writes this dict straight into validation.json.
"""
import re
from difflib import SequenceMatcher

SIMILARITY_THRESHOLD = 0.95

_WHITESPACE_RE = re.compile(r"\s+")
_PAGE_MARKER_RE = re.compile(r"\[\[page (\d+)\]\]")


def normalize_whitespace(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()


def _page_at_offset(offset: int, normalized_text: str) -> int | None:
    """Which `[[page N]]` marker precedes `offset` in `normalized_text`. None for text with
    no page markers (HTML, or DOCX) -- there's nothing to check a page hint against."""
    page = None
    for m in _PAGE_MARKER_RE.finditer(normalized_text):
        if m.start() > offset:
            break
        page = int(m.group(1))
    return page


def _best_fuzzy_window(quote: str, text: str) -> tuple[float, int, int]:
    """Finds the window of `text` that best matches `quote`, using SequenceMatcher's
    matching blocks to locate candidate alignments (an O(n) diff) and then scoring each
    candidate window precisely. Returns (similarity, start, end); similarity is 0.0 with
    start=end=0 if `text` or `quote` is empty."""
    qlen = len(quote)
    if not qlen or not text:
        return 0.0, 0, 0

    matcher = SequenceMatcher(None, text, quote, autojunk=False)
    best_ratio, best_start, best_end = 0.0, 0, min(qlen, len(text))
    for block in matcher.get_matching_blocks():
        if block.size == 0:
            continue
        start = max(0, block.a - block.b)
        end = min(len(text), start + qlen)
        ratio = SequenceMatcher(None, text[start:end], quote, autojunk=False).ratio()
        if ratio > best_ratio:
            best_ratio, best_start, best_end = ratio, start, end
    return best_ratio, best_start, best_end


def anchor_quote(quote_text: str, page_hint: int | None, document_text: str) -> dict:
    """Fuzzy-substring-matches `quote_text` against `document_text` (normalizing
    whitespace on both sides first). `page_hint` (nullable -- null for HTML/DOCX quotes)
    is checked against the `[[page N]]` marker nearest the matched offset.

    Returns {"anchored", "similarity", "offset", "page_match"} matching
    schemas/validation.schema.json's anchor_result: `offset` is a [start, end] character
    range into the normalized text, or null when unanchored.
    """
    normalized_text = normalize_whitespace(document_text)
    normalized_quote = normalize_whitespace(quote_text)

    if not normalized_quote or not normalized_text:
        return {"anchored": False, "similarity": 0.0, "offset": None, "page_match": None}

    idx = normalized_text.find(normalized_quote)
    if idx != -1:
        similarity, start, end = 1.0, idx, idx + len(normalized_quote)
    else:
        similarity, start, end = _best_fuzzy_window(normalized_quote, normalized_text)

    anchored = similarity >= SIMILARITY_THRESHOLD
    if not anchored:
        return {"anchored": False, "similarity": round(similarity, 4), "offset": None, "page_match": None}

    page_match = None
    if page_hint is not None:
        page_match = _page_at_offset(start, normalized_text) == page_hint

    return {
        "anchored": True,
        "similarity": round(similarity, 4),
        "offset": [start, end],
        "page_match": page_match,
    }
