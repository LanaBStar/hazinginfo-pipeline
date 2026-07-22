# Operations

This is the state machine for the HazingInfo.org CHTR archival pipeline, in prose. It is
agent-agnostic — followed by whichever AI agent is acting as the operator console for a
session. See `CLAUDE.md` for the full architecture (this file operationalizes it into a
runnable menu).

## The three console rules (verbatim)

1. **The menu is computed, never remembered.** Every render = fresh `status.py` call.
2. **The agent does only three things**: run runbook scripts, execute packet prompts,
   ask questions.
3. **Chat is ephemeral; decisions become files.**

## Boot behavior

On session start, and before every menu render:

1. Run `python status.py`.
2. Format its JSON output as a numbered menu.
3. If `smoke_run.done_this_year` is `false`, the **first menu item** is the fixtures smoke
   run, and no annual-pass step may be started before it completes successfully.

The agent may do exactly three things:

1. Execute scripts named in a job's `RUNBOOK.md`.
2. Perform the AI work defined by a task packet's `prompt.md`.
3. Ask the operator questions.

The agent never edits archive or catalog data directly, never improvises steps not in a
runbook, and never answers "what's the pipeline state?" from memory — it always re-runs
`status.py`. Any operator decision that affects data must be written to a file that a
script reads; a chat answer is not a decision.

## `status.py` output shape

```json
{
  "scrape_year": 2026,
  "smoke_run": {"done_this_year": false},
  "discover":  {"confirmed_urls": 1391, "pending_candidates": 12, "no_url": 81, "airtable_mismatches": 4},
  "archive":   {"institutions_done": 1391, "pending": 93, "documents": 2140},
  "normalize": {"pending_documents": 14, "no_text_layer": 63},
  "extract":   {"packets_total": 68, "packets_done": 52, "awaiting_validation": 1, "low_confidence": 9},
  "review":    {"incidents_pending": 141, "incidents_decided": 655, "organizations_pending": 18},
  "publish":   {"last_rebuild": "2026-06-02", "approved_unpublished": 118}
}
```

(No tier-based review counts — review is single-reviewer, flag-informed; see `CLAUDE.md`.)

This is the shape, not exhaustive — `status.py` may add fields as later phases land, but
never remove the ones the menu depends on.

## Pipeline flow and menu items

```
sources/schools.csv (1,484 institutions, versioned in repo)
        │
  01-discover    agent: verify/find CHTR URLs → candidates file → human confirms → merge.py
        │        → cross-check against the Airtable schools-registry base (v3.0)
  02-archive     python: fetch originals + assets → R2 (manifest.json per doc, status.json
        │        per school-year, ledger entry per URL, data_check per institution-cycle)
  03-normalize   python: extracted text for every document (incl. PDF text layers) → R2
        │
  04-extract     agent packets: is_chtr + incidents.json (raw+normalized fields, per-
        │        incident confidence + flags, organization proposal) → validate.py
        │        (schema conformance only, v3.0) → R2
  05-review      volunteers via web app → review.json (single decision + per-field
        │        corrections + independent organization decision) → R2 (operator reviews
        │        in the SAME app)
  06-publish     python: full catalog rebuild from R2 → Neon (staging + public schemas,
                 organization matching, cross-year status resolution) → public site
```

Each menu item corresponds to a job directory under `jobs/`. Every job directory has a
`RUNBOOK.md`: purpose, preconditions, steps, postconditions, failure modes. The agent reads
the runbook before acting and follows it — it does not invent steps.

- **0. Smoke run** (mandatory first step when `smoke_run.done_this_year` is false) — runs
  the full pipeline over `fixtures/` into a `smoke/` archive prefix, never mixed with real
  data.
- **1. Discover** — batches of ~25–50 schools get candidate URLs from the agent; the
  operator confirms via chat, which the agent writes to a decisions file; `merge.py`
  validates and merges into `sources/schools.csv`. The agent then cross-checks the
  confirmed URL against the existing Airtable schools-registry base's `Transparency
  Report` field for that institution; a mismatch is surfaced in the menu
  (`discover.airtable_mismatches`) for the operator to look at — neither source is ever
  silently overwritten by the other.
- **2. Archive** — `jobs/02-archive/run.py` fetches originals for institutions whose
  current-year `status.json` doesn't yet exist. Resumable by construction. Also writes
  the new `ledger/` fingerprint entries and one `data_check.json` per institution per
  cycle.
- **3. Normalize** — `jobs/03-normalize/run.py` extracts text for every archived document
  lacking one.
- **4. Extract** — `make_packets.py` builds one task packet per document lacking a
  current-version extraction; the agent works a packet via its `prompt.md`; `validate.py`
  checks schema conformance only (v3.0 — no anchoring, no tier) before archiving.
- **5. Review** — status only, rendered read-only in the menu. Reviewing itself — by
  volunteers or the operator — happens in the review web app (`jobs/05-review/app/`),
  never in chat, so every decision produces the same `review.json` audit trail. Incidents
  and their proposed organizations are reviewed together but decided independently
  (`review.organizations_pending` tracks the organization queue separately). There is no
  escalation queue in v3.0 — an item a reviewer can't decide just stays `Pending review`
  for another volunteer or the operator.
- **6. Publish** — `jobs/06-publish/rebuild.py` drops and rebuilds the entire catalog
  (`staging` + `public` schemas) from the archive. Run after every review batch.

## Preconditions and transitions

- Discover candidates can't be merged until the operator has confirmed them (chat →
  decisions file → `merge.py`); the Airtable cross-check runs after merge, never before.
- Archive only fetches institutions with a confirmed URL (or explicitly records
  `no_url`/`not_found`).
- Normalize only runs on documents that archive has fetched.
- Extract packets are only built for normalized documents lacking a current extraction
  version.
- There are no review tiers — every incident and every organization proposal gets the
  same single-reviewer policy, informed by the AI's own `extraction_confidence` and
  `flags[]` rather than routed by them. See `CLAUDE.md`'s "05-review" section.
- Publish is safe to run at any time; it is a pure function of the archive and always
  fully rebuilds rather than incrementally updating.

## What "decisions become files" means in practice

Examples: discover confirmations, review approvals/rejections/corrections, and any
operator override — all are written synchronously to a file in the archive or a job's
`tasks/`/decisions directory by a validating script, never left as only a chat message.
