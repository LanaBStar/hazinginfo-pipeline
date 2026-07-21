# 04-extract: extraction prompt (extract_v2 — v3.0 pipeline)

You are extracting structured data from a single institution's Campus Hazing
Transparency Report (CHTR) filing, published under the Stop Campus Hazing Act.

## What you have

This packet contains:
- `original.pdf` or `original.html` -- the actual document. **Read this as your
  source of truth.** For PDFs, read the file natively (pages, layout, everything) --
  do not rely on `text.txt` for anything other than checking wording.
- `text.txt` -- the plain-text extraction of the original. It may have collapsed
  whitespace or reflowed line breaks. PDFs have `[[page N]]` markers (useful for your
  own navigation; nothing downstream anchors a field to a specific page in v3.0).
- `schema.json` -- the exact JSON Schema your `incidents.json` output must satisfy.
- `metadata.json` -- a stub. Copy it and fill in `model` (your model name) and
  `created` (current UTC timestamp, ISO 8601) when you're done. Leave every other
  field untouched.

## What to produce

Write `incidents.json` in this same directory, matching `schema.json` exactly. Every
`_raw` field is the source text **verbatim** (copy exact wording -- no paraphrasing, typo
correction, or summarizing); every non-`_raw` field is your own interpretation of that
raw text. There are no more `{text, page}` quote objects or character offsets in v3.0 --
`validate.py` only checks schema conformance now, nothing anchors a field to a location.

## Rules (non-negotiable)

1. **Everything is nullable except `description_raw`.** If a field isn't stated in the
   document, leave the raw field `null` and any derived value `null` too. Do not guess.
2. **A missing `organization_name_raw` is itself meaningful** -- the Act requires
   institutions to name the organization, so its absence gets surfaced via a
   `"Required field missing"` flag, not silently accepted. Record `null`, don't invent a
   placeholder.
3. **Organization name: `organization_name_raw` vs `organization_name_normalized`.**
   `organization_name_raw` is the full text as published (chapter designators, Greek
   letters, "(Inc.)", everything). `organization_name_normalized` strips chapter
   designators (e.g. "Beta Chapter"), legal-entity suffixes ("Inc.", "LLC"), and
   redundant type words already captured by `organization_type` ("Fraternity",
   "Sorority") *unless* the word is genuinely part of the org's own name -- keep
   distinctive names/Greek letters intact (e.g. "Alpha Kappa Kappa" stays as-is). Goal:
   the same clean name regardless of which chapter/institution reported the incident. If
   ambiguous, don't guess -- a wrong merge or split here causes real matching errors
   downstream, so flag it (`field_name: "organization_name_normalized"`) instead.
4. **`organization_type`** -- pick from the schema's enum based on the org's own
   self-description. Tiebreakers, in priority order: (1) Greek-lettered orgs
   (self-identifying as fraternity/sorority) always default to Fraternity/Sorority even
   if also religious or unrecognized; (2) an org tied to both an academic discipline and
   a leadership/selectivity mission defaults to Honor/Leadership Society over
   Academic/Professional Club; (3) a performance/drill unit embedded in a Corps/military
   structure defaults to Military/Cadet Organization over Performing/Spirit Group; (4) an
   org whose primary function is welcoming/mentoring incoming students defaults to
   Orientation/Mentorship Program over Religious/Faith-Based Organization, even under
   religious framing; (5) General Interest/Social Club is a catch-all, last resort. Leave
   `null` and flag (`"Unable to determine organization type"`) if genuinely undeterminable
   -- never invent a value.
5. **`alcohol_involved` / `drugs_involved`** are independent (`"Yes"|"No"|"Not
   specified"`), populated separately even when the source presents them as one combined
   field. Three source patterns: (a) separate per-substance fields -- map each directly;
   (b) one combined "alcohol and/or drugs" field -- a combined affirmative does **not**
   confirm both substances: first try to allocate from surrounding description/findings/
   sanctions text, setting only the substance(s) actually named to `"Yes"`. Never infer
   `"No"` for the unconfirmed substance from silence -- if the text names alcohol but
   never mentions drugs, drugs stays `"Not specified"`, not `"No"`. If the combined field
   is affirmative, **always** add an `"Alcohol/drugs review needed"` flag regardless of
   whether you could allocate -- a combined "Yes" is structurally ambiguous even when
   you're confident. A combined `"No"` needs no flag (unambiguous, applies to both). (c)
   stated only in narrative text, no labeled field -- read it from there; flag only if
   genuinely unrecoverable. Bar for inferring `"Yes"` from narrative alone: only an
   unambiguous statement of use/intoxication ("found intoxicated," "vomiting from
   drinking," a stated blood alcohol level) -- not adjacent scene-setting ("party,"
   "tailgate") without explicit evidence of actual use.
6. **`determination_status`** -- the institution's own determination: `"Pending"`
   (investigation ongoing, no finding yet), `"Determined hazing"`, `"Dismissed"`, or
   `"Not specified"` if the document doesn't state one. If genuinely unclear which
   applies, use `"Not specified"` and add a `"Determination unclear"` flag rather than
   guessing.
7. **Dates** -- every date field has a `_raw` (verbatim), a normalized ISO 8601 value,
   and (for incident start/end only) a `_precision` (`"Day"|"Month"|"Academic term"|
   "Academic year"|"Year"|"Unknown"`) reflecting how precisely the source actually
   states it -- don't invent a `"Day"`-precision date from a source that only says "Fall
   2025." If a date term doesn't map to a recognizable calendar value at all, use
   `"Unknown"` precision and add an `"Unrecognized date term"` flag rather than
   guessing a normalized value. `notice_date` (when the org was formally told of the
   outcome) is distinct from `investigation_end_date` (when the finding was made) --
   some institutions report them together with one shared date; only merge them if the
   source explicitly does.
8. **`zero_incidents_statement`** (on `document`, not on any incident) is for the case
   where the report states there were zero incidents in the period -- quote the
   document's own statement verbatim. Leave `null` if the report describes one or more
   incidents.
9. **`extraction_confidence`** (per incident, 0.0-1.0) is your own calibrated
   self-assessment of this specific incident's extraction, not the whole document's. Be
   honest, not optimistic -- this drives which incidents a human reviewer looks at more
   carefully.
10. **`flags`** is a structured array, not free text: each entry is
    `{"flag_type": "...", "field_name": "...", "note": "..."|null}` using exactly the
    `flag_type` values `schema.json` defines. Add one entry per distinct condition, even
    within the same incident (e.g. a missing organization *and* an unclear
    determination is two flag entries, not one). `note` is optional context, not a
    substitute for choosing the right `flag_type`.
11. **Do not add fields.** Never add: a hazing-type taxonomy, a sanction-severity level,
    `location` (on/off-campus), `is_aggravated`, or `date_reported`. `schema.json`
    rejects unknown fields, but don't even attempt it -- these are deliberately excluded
    from this pipeline (they can be computed later, downstream of human verification, if
    ever wanted).
12. **`is_chtr`**: set `false` if this document is not actually a Campus Hazing
    Transparency Report (e.g. it's an index page, an unrelated PDF, a different kind of
    compliance filing). When `false`, `incidents` must be `[]` and every `document`
    field should be `null` unless the document genuinely states it for a non-CHTR
    reason.
13. **Segmentation is your job, but don't force it.** Each distinct incident described
    in the report is one entry in `incidents`. If the document is ambiguous about
    whether something is one incident or two, extract your best reading and flag it if
    genuinely uncertain -- a human reviewer checks segmentation, not you.

## If you can't complete this packet

If the original is unreadable, corrupted, or you cannot form an opinion on `is_chtr`,
still write your best-effort `incidents.json` (even `{"is_chtr": false, "incidents":
[], ...}` with everything else null is valid) rather than leaving the packet
unfinished -- `validate.py` archives whatever you produce, valid or not, so the
document isn't silently skipped.
