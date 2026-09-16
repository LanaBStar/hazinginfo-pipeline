"""HTTP fetch helper shared by 01-discover and 02-archive. Ported retry/backoff
behavior from the old repo's helpers.py (battle-tested against flaky university sites)."""
import logging
import time
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests

USER_AGENT = "Mozilla/5.0 (compatible; CHTRBot/1.0; +https://hazinginfo.org)"
HEADERS = {"User-Agent": USER_AGENT}
REQUEST_TIMEOUT = 20

# Query parameters that identify where a visitor came from and never change what is
# served. Left in place they produce a second copy of a page we already have: Georgia
# Tech's hazing-conduct-history was archived twice, once plain and once with
# ?utm_source=chatgpt.com, because someone had linked it that way.
#
# Deliberately narrow. Query strings are often load-bearing — Georgia Tech paginates its
# conduct history with ?page=0/1/2, and dropping that would lose most of the report — so
# only parameters known to be pure attribution are removed.
_TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "igshid", "_hsenc", "_hsmi",
}


def normalize_url(url: str) -> str:
    """Canonical form of a link, applied before it is queued, fetched or stored so that
    all three agree.

    Two rules, both from observed failures:

    - Tracking parameters are stripped (see _TRACKING_PARAMS above).
    - A Dropbox share link is switched from `dl=0` to `dl=1`. With dl=0 Dropbox serves an
      HTML preview page rather than the file, so a shared PDF arrives as markup with no
      readable report text in it and is stored as a web page. Observed on Georgia State's
      former student-conduct page, which linked case-result PDFs this way
      (2018_Kappa_Sigma_Results.pdf and others). Those particular documents pre-date the
      Stop Campus Hazing Act and are not CHTR incidents, so nothing in scope was lost —
      but the dl=0 pattern is how schools share files generally, and the next school to
      park an actual report on Dropbox would have hit the same wall.
    """
    parts = urlparse(url)
    if not parts.query:
        return url

    original = parse_qsl(parts.query, keep_blank_values=True)
    pairs = [(k, v) for k, v in original if k.lower() not in _TRACKING_PARAMS]
    changed = len(pairs) != len(original)

    host = parts.netloc.lower()
    if host.endswith("dropbox.com"):
        if any(k == "dl" and v != "1" for k, v in pairs):
            pairs = [(k, "1" if k == "dl" else v) for k, v in pairs]
            changed = True
        elif not any(k == "dl" for k, _ in pairs):
            pairs.append(("dl", "1"))
            changed = True

    # Leave the URL exactly as found unless something actually needed changing.
    # Re-encoding is not lossless: a bare-key query string like Maxient's
    # `chtr.php?GeorgiaStateUniv` comes back as `chtr.php?GeorgiaStateUniv=`, which is a
    # different URL and may not resolve. Only rebuild when there is a reason to.
    if not changed:
        return url

    return urlunparse(parts._replace(query=urlencode(pairs)))


def fetch_url(url: str, retries: int = 3, timeout: int = REQUEST_TIMEOUT) -> requests.Response | None:
    """GET with retries and exponential backoff. Returns None (never raises) once retries
    are exhausted, so callers can record a fetch failure as data rather than crash."""
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=timeout)
            resp.raise_for_status()
            return resp
        except Exception as e:
            if attempt < retries:
                wait = 2 ** attempt
                logging.warning(f"fetch failed {url} (attempt {attempt}/{retries}): {e} - retrying in {wait}s")
                time.sleep(wait)
            else:
                logging.warning(f"fetch failed {url} (attempt {attempt}/{retries}): {e} - giving up")
    return None


def is_pdf_response(resp: requests.Response, url: str) -> bool:
    """Whether this response should be stored as a PDF.

    The URL test looks at the PATH only. Checking the whole URL meant that any file link
    carrying a query string — `…/2018_Kappa_Sigma_Results.pdf?rlkey=abc&dl=0` — failed the
    test and was handled as HTML, which is how Georgia State's case-result PDFs came to be
    stored as web pages. It also disagreed with 02-archive's own _is_pdf_url, which has
    always used the path, so a link could be followed *as* a PDF and then stored as if it
    were a web page.
    """
    content_type = resp.headers.get("Content-Type", "")
    return "application/pdf" in content_type or urlparse(url).path.lower().endswith(".pdf")
