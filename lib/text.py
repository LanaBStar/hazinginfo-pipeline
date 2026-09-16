"""Text extraction for 03-normalize: HTML -> text, DOCX -> text, PDF -> text with page
markers. No OCR - a PDF with no text layer yields "" (the extraction agent has nothing
to read and reports its own low/no confidence and a flag on that document instead).
"""
import io
import zipfile
from xml.etree import ElementTree

from bs4 import BeautifulSoup
from pypdf import PdfReader

_DOCX_BODY_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Below this many characters, a narrowed content root is treated as not real content and
# the whole document is used instead. See html_to_text.
_MIN_NARROWED_TEXT = 200


def html_to_text(html: str) -> str:
    """Readable text from an HTML page, with site furniture removed.

    Narrowing to <main>/#content/#main-content usually improves the result, but it has to
    be conditional. Many university templates include an EMPTY skip-link anchor — the
    `<div id="main-content"></div>` that "skip to main content" jumps to — and narrowing
    to that silently discards the entire page.

    Observed: Georgia Tech's CHTR page (osi.gatech.edu/hazing-conduct-history) is 50,616
    characters of HTML holding 5,428 characters of readable text, of which this function
    previously returned NONE, because it found an empty `#main-content` and stopped. The
    page was then judged to contain no hazing keyword and was never archived. That failure
    was silent — no error, just an empty string — and it affects every school whose
    template uses the same accessibility pattern.

    So a narrowed root is accepted only when it actually holds text; otherwise the whole
    (furniture-stripped) document is used. Pages with a real <main>, like Alabama A&M's,
    are unaffected: their narrowed root holds thousands of characters and is still chosen.

    This function also feeds 03-normalize's extracted/text.txt, which is what the AI reads
    at extraction time — so text lost here is not merely a crawl miss, it is missing input
    to every downstream judgment about the document.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    for tag in soup.select("aside, [class*='sidebar'], [class*='breadcrumb'], [id*='sidebar']"):
        tag.decompose()

    for candidate in (soup.find("main"), soup.find(id="content"), soup.find(id="main-content")):
        if candidate is None:
            continue
        narrowed = candidate.get_text(separator="\n", strip=True)
        if len(narrowed) >= _MIN_NARROWED_TEXT:
            return narrowed
        # An empty or near-empty content root is a skip-link anchor, not the content.
        # Fall through rather than returning it.

    return soup.get_text(separator="\n", strip=True)


def pdf_to_text(content: bytes) -> str:
    """Page markers (`[[page N]]`) let anchoring verify a quote's page hint. Returns ""
    when no page has an extractable text layer (scanned PDF)."""
    reader = PdfReader(io.BytesIO(content))
    pages_text = [(page.extract_text() or "") for page in reader.pages]
    if not any(text.strip() for text in pages_text):
        return ""
    parts = [f"[[page {i}]]\n{text}" for i, text in enumerate(pages_text, start=1)]
    return "\n".join(parts).strip()


def docx_to_text(content: bytes) -> str:
    """Reads word/document.xml directly out of the .docx zip container - stdlib only,
    no added dependency for a format normalize only needs to read once per document."""
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        document_xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(document_xml)
    paragraphs = []
    for paragraph in root.iter(f"{_DOCX_BODY_NS}p"):
        runs = [node.text or "" for node in paragraph.iter(f"{_DOCX_BODY_NS}t")]
        paragraphs.append("".join(runs))
    return "\n".join(paragraphs).strip()
