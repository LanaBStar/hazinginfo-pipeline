"""HTTP fetch helper shared by 01-discover and 02-archive. Ported retry/backoff
behavior from the old repo's helpers.py (battle-tested against flaky university sites)."""
import logging
import time

import requests

USER_AGENT = "Mozilla/5.0 (compatible; CHTRBot/1.0; +https://hazinginfo.org)"
HEADERS = {"User-Agent": USER_AGENT}
REQUEST_TIMEOUT = 20


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
    content_type = resp.headers.get("Content-Type", "")
    return "application/pdf" in content_type or url.lower().endswith(".pdf")
