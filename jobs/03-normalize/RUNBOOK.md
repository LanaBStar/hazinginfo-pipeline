# 03-normalize

## Purpose

Produce `extracted/text.txt` for every archived document, so 04-extract's agent packets
always include a plain-text rendering of the document alongside the original. No AI runs
here.

PDF text includes `[[page N]]` markers. These are navigational only — nothing downstream
anchors a field to a specific page in v3.0 (quote anchoring and `lib/quotes.py` were
retired). A PDF with no extractable text layer (scanned) yields an empty `text.txt`, which
is not a failure: `prompt.md` directs the extracting agent to read `original.pdf` natively
as its source of truth and to use `text.txt` only for checking wording, so extraction still
proceeds normally from the page images.

## Preconditions

- At least one document exists under `archive/{unitid}_{slug}/{year}/docs/{hash}/` with a
  `manifest.json` (i.e. 02-archive has run).
- No write credentials are required from the agent — plain Python script; set
  `ARCHIVE_LOCAL_ROOT` for a local/fixtures run, or the `R2_*` env vars for a real run.

## Steps

1. Run: `python jobs/03-normalize/run.py` (optionally `--prefix smoke/` to normalize the
   sandboxed smoke-run archive instead of the real one).
2. For every doc directory with a `manifest.json`:
   - Skip if `extracted/text.txt` already exists (resumable/idempotent).
   - Read the original bytes from `original/` and dispatch on `manifest.json`'s
     `content_type`: `application/pdf` -> `lib/text.pdf_to_text`, `text/html` ->
     `lib/text.html_to_text`, the DOCX MIME type -> `lib/text.docx_to_text`.
   - Write `extracted/text.txt` unconditionally, even when extraction yields `""`
     (absence — no text layer — is data, same principle as `status.json`).

## Postconditions

- Every document that had a `manifest.json` before this run now also has
  `extracted/text.txt` (possibly empty).
- `status.py`'s `normalize.pending_documents` drops to 0 for the processed prefix;
  `normalize.no_text_layer` reflects any scanned PDFs found.

## Failure modes

- A single document's extraction failure (corrupt PDF, unsupported `content_type`, etc.)
  must not abort the whole run — catch, log, and continue to the next document; that
  document's `pending_normalize` count in `status.py` simply stays nonzero until fixed.
- An unsupported `content_type` (anything other than PDF/HTML/the DOCX MIME type) raises
  rather than silently writing garbage — 02-archive currently only ever stores PDF or HTML,
  so this should not occur until a future job starts archiving other formats.
