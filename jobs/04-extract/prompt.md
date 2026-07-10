# 04-extract: extraction prompt (extract_v1)

You are extracting structured data from a single institution's Campus Hazing
Transparency Report (CHTR) filing, published under the Stop Campus Hazing Act.

## What you have

This packet contains:
- `original.pdf` or `original.html` -- the actual document. **Read this as your
  source of truth.** For PDFs, read the file natively (pages, layout, everything) --
  do not rely on `text.txt` for anything other than checking wording.
- `text.txt` -- the plain-text extraction of the original that a separate script
  (`validate.py`) will mechanically check your quotes against. It may have collapsed
  whitespace or reflowed line breaks. PDFs have `[[page N]]` markers.
- `schema.json` -- the exact JSON Schema your `incidents.json` output must satisfy.
- `metadata.json` -- a stub. Copy it and fill in `model` (your model name) and
  `created` (current UTC timestamp, ISO 8601) when you're done. Leave every other
  field untouched.

## What to produce

Write `incidents.json` in this same directory, matching `schema.json` exactly.

## Rules (non-negotiable)

1. **Every quote is `{"text": "...", "page": N}`.** `text` must be a **verbatim**
   substring of the document -- copy the exact wording, do not paraphrase, correct
   typos, or summarize. `page` is a 1-indexed page number for PDFs, `null` for HTML.
   Never invent character offsets -- `validate.py` computes those itself.
2. **Everything is nullable except `description_quote`.** If a field isn't stated in
   the document, its quote is `null` and any derived value (a date, a boolean) is
   also `null`. Do not guess.
3. **A missing `organization_quote` is itself meaningful** -- the Act requires
   institutions to name the organization, so its absence gets surfaced for review,
   not silently accepted. Still record it as `null` when the document truly doesn't
   name one; don't invent a placeholder to avoid the flag.
4. **`zero_incidents_quote`** (on `document`, not on any incident) is for the case
   where the report states there were zero incidents in the period. It must quote the
   document's own statement to that effect. Leave it `null` if the report describes
   one or more incidents.
5. **The only interpretation you do is normalizing dates to ISO 8601 and setting the
   two booleans** (`alcohol_involved`, `drugs_involved`) -- and only when the document
   states them plainly enough that a reader looking at the same quote would agree.
   When genuinely ambiguous, use `null`.
6. **Do not add fields.** In particular, never add: a hazing-type taxonomy, a
   sanction-severity level, `location` (on/off-campus), `is_aggravated`,
   `date_reported`, or `org_type`. `schema.json` rejects unknown fields, but don't
   even attempt it -- these are deliberately excluded from this pipeline (they can be
   computed later, downstream of human verification, if ever wanted).
7. **`is_chtr`**: set `false` if this document is not actually a Campus Hazing
   Transparency Report (e.g. it's an index page, an unrelated PDF, a different kind of
   compliance filing). When `false`, `incidents` must be `[]` and every `document`
   field should be `null` unless the document genuinely states it for a non-CHTR
   reason.
8. **Segmentation is your job, but don't force it.** Each distinct incident described
   in the report is one entry in `incidents`. If the document is ambiguous about
   whether something is one incident or two, extract your best reading -- a human
   reviewer checks segmentation, not you.

## If you can't complete this packet

If the original is unreadable, corrupted, or you cannot form an opinion on `is_chtr`,
still write your best-effort `incidents.json` (even `{"is_chtr": false, "incidents":
[], ...}` with everything else null is valid) rather than leaving the packet
unfinished -- `validate.py` archives whatever you produce, valid or not, so the
document isn't silently skipped.
