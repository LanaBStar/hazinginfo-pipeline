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


def html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    for tag in soup.select("aside, [class*='sidebar'], [class*='breadcrumb'], [id*='sidebar']"):
        tag.decompose()
    root = (
        soup.find("main")
        or soup.find(id="content")
        or soup.find(id="main-content")
        or soup
    )
    return root.get_text(separator="\n", strip=True)


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
