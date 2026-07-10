# 01-discover: CHTR URL discovery prompt

You are searching the web to find, for each institution in this batch, its official
Campus Hazing Transparency Report (CHTR) page or document — published under the Stop
Campus Hazing Act.

## What you have

This packet contains:
- `schools_slice.csv` — this batch's slice of `sources/schools.csv`: `unitid`, `name`,
  `state`, `chtr_url`, `url_status`, `evidence`. Every row in this slice has an empty
  `url_status` — it has never been searched before, or a previous search found nothing
  and it's being retried this pass.
- `schema.json` — the exact JSON Schema your `candidates.json` output must satisfy.

## What to produce

Write `candidates.json` in this same directory, matching `schema.json` exactly:
`{"schema_version": 1, "batch": "<this batch's directory name>", "candidates": [...]}`.

For **each** school in `schools_slice.csv`, search the web for its official CHTR page —
usually on the institution's own domain, under titles like "Campus Hazing Transparency
Report," "Hazing Transparency Report," or similar Stop Campus Hazing Act compliance
language. If you find one, add a candidate:

```json
{
  "unitid": "228778",
  "proposed_url": "https://titleix.utexas.edu/hazing-transparency-report",
  "confidence": 0.9,
  "evidence_quote": "Campus Hazing Transparency Report — Fall 2025"
}
```

## Rules (non-negotiable)

1. **You never edit `sources/schools.csv`.** This job only ever produces
   `candidates.json`; a human confirms candidates via the console, and `merge.py` — a
   validating script, not you — is the only thing that writes to `schools.csv`.
2. **One candidate entry per school you found a plausible URL for.** If you searched and
   found nothing plausible for a school, omit it from `candidates` entirely — do not
   invent a URL or emit a placeholder. A school missing from `candidates` is picked up
   again next batching pass.
3. **`proposed_url` must be the specific CHTR page or document**, not the institution's
   homepage or a generic compliance-office landing page, unless that page *is* the CHTR
   (e.g. embeds the report inline).
4. **`evidence_quote` is a verbatim quote** from the page you found — the text that
   convinced you this is the school's CHTR (a title, a heading, an introductory
   sentence). Do not paraphrase or summarize.
5. **`confidence` is your own calibrated estimate**, 0 to 1, of how likely `proposed_url`
   is genuinely this school's official CHTR. It is shown to the operator as one input to
   their own judgment when confirming — it does not gate or auto-decide anything by
   itself, so don't inflate it to get a candidate "accepted."
6. **Do not fetch or archive documents.** That is `02-archive`'s job, after a human
   confirms the URL. You are only locating and citing evidence for the URL itself.
