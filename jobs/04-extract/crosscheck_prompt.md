# 04-extract: cross-check prompt (second pass)

Per IMPLEMENTATION_PLAN.md Section 9. This is a **second, independent** agent pass
over a document that has already been extracted once. Its job is to catch what the
first pass missed -- two AI passes agreeing is a much weaker signal than one AI pass
being right, but disagreement is a strong, cheap signal that something needs a
closer look.

> **Not wired up yet.** As of this phase, there is no packet-creation script or
> archived-output convention for this second pass -- `04-extract/validate.py` always
> records `crosscheck: null`, so per the Section 9 tier table no incident can reach
> "standard" from this job today (only "fast" and "flagged" are reachable). This
> prompt is a deliverable of this phase; wiring it into the pipeline (a
> `make_crosscheck_packets.py`, an archived `crosscheck.json` next to `incidents.json`,
> and validate.py reading it) is left to a later phase.

## What you have

- The original document (read it natively, same as the first pass).
- The first pass's `incidents.json` for this same document.

## What to do

For **each** entry in `incidents.json`'s `incidents` array (by index, 0-based), verify
it against the original document, field by field:

- Does `organization_quote.text` (if not `null`) appear verbatim, naming the
  organization the document actually names?
- Does `description_quote.text` actually describe what happened, without adding or
  dropping detail the document doesn't support?
- Do `findings_quote`, `sanction_quotes`, and the `dates` block (if not `null`) match
  what the document states, on the pages cited?
- Are `alcohol_involved` / `drugs_involved` consistent with what's actually written,
  not an inference beyond the quoted text?
- Is this genuinely one incident, or does the original actually describe this as two
  (or is this entry actually two of the original's incidents merged into one)?

Cite the page(s) you checked against for each incident.

## What to produce

For each incident index, a verdict:

```json
{"agrees": true, "notes": "All fields confirmed on page 2."}
```

or, when something's off:

```json
{"agrees": false, "notes": "Description quote on page 2 says 'physically demanding tasks'; extraction wrote 'physical hazing acts', not verbatim. Sanction quote correct."}
```

`agrees` is `true` only if **every** field for that incident checks out; `notes` must
say what you checked and, if `agrees` is `false`, exactly what's wrong and where.
Never soften a disagreement to avoid escalating it -- the whole point of this pass is
that two AI blind spots rarely coincide, and this pass exists to catch the first
pass's mistakes, not to rubber-stamp it.
