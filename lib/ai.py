"""Builds Claude API content blocks for original documents, for jobs that call the API
directly (04-extract's extract step). Claude's `document` content block requires PDF
bytes base64-encoded -- there's no equivalent block type for HTML, so an HTML original
is sent as a plain `text` block instead, since the model reads markup as text either way
and base64 would only inflate it.
"""
import base64
import json

from lib import r2


def _original_key(doc_dir: str) -> str:
    prefix = f"{doc_dir}/original/"
    candidates = sorted(k for k in r2.list_keys(prefix) if "/assets/" not in k)
    if not candidates:
        raise FileNotFoundError(f"no original document found under {prefix}")
    return candidates[0]


def build_original_content_block(doc_dir: str) -> dict:
    """A single Claude API content block for the original document under `doc_dir`
    (`{prefix}{unitid}_{slug}/{scrape_year}/docs/{hash16}`) -- a `document` block
    (base64-encoded bytes) for a PDF, a `text` block (raw markup) for HTML.
    `doc_dir`'s manifest.json `content_type` decides which."""
    manifest = json.loads(r2.get_bytes(f"{doc_dir}/manifest.json"))
    content_type = manifest["content_type"]
    original_bytes = r2.get_bytes(_original_key(doc_dir))

    if content_type == "application/pdf":
        return {
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": base64.b64encode(original_bytes).decode("ascii"),
            },
        }
    if content_type == "text/html":
        return {
            "type": "text",
            "text": original_bytes.decode("utf-8"),
        }
    raise ValueError(f"lib.ai: unsupported content_type {content_type!r} for {doc_dir}")
