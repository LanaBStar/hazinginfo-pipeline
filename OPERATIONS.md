# Operations

This is the state machine for the HazingInfo.org CHTR archival pipeline, in prose. It is
followed by whichever agent (Claude Cowork or Codex) is acting as the operator console —
see `CLAUDE.md` / `AGENTS.md` for the boot instruction, and `IMPLEMENTATION_PLAN.md` for
the full design (this file operationalizes IMPLEMENTATION_PLAN.md §5).

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
  "discover":  {"confirmed_urls": 1391, "pending_candidates": 12, "no_url": 81},
  "archive":   {"institutions_done": 1391, "pending": 93, "documents": 2140},
  "normalize": {"pending_documents": 14, "no_text_layer": 63},
  "extract":   {"packets_total": 68, "packets_done": 52, "awaiting_validation": 1},
  "review":    {"fast_lane": 812, "standard": 141, "flagged": 46, "decided": 655},
  "publish":   {"last_rebuild": "2026-06-02", "approved_unpublished": 118}
}
```

This is the shape, not exhaustive — `status.py` may add fields as later phases land, but
never remove the ones the menu depends on.

## Pipeline flow and menu items

```
sources/schools.csv (1,484 institutions, versioned in repo)
        │
  01-discover    agent: verify/find CHTR URLs → candidates file → human confirms → merge.py
        │
  02-archive     python: fetch originals + assets → R2 (manifest.json per doc, status.json per school-year)
        │
  03-normalize   python: extracted text for every document (incl. PDF text layers) → R2
        │
  04-extract     agent packets: is_chtr + incidents.json → validate.py (schema + anchoring + tier) → R2
        │
  05-review      volunteers via web app → review.json → R2   (operator reviews in the SAME app)
        │
  06-publish     python: full catalog rebuild from R2 → Neon → public site
```

Each menu item corresponds to a job directory under `jobs/`. Every job directory has a
`RUNBOOK.md`: purpose, preconditions, steps, postconditions, failure modes. The agent reads
the runbook before acting and follows it — it does not invent steps.

- **0. Smoke run** (mandatory first step when `smoke_run.done_this_year` is false) — runs
  the full pipeline over `fixtures/` into a `smoke/` archive prefix, never mixed with real
  data. See `IMPLEMENTATION_PLAN.md` §14.
- **1. Discover** — batches of ~25–50 schools get candidate URLs from the agent; the
  operator confirms via chat, which the agent writes to a decisions file; `merge.py`
  validates and merges into `sources/schools.csv`.
- **2. Archive** — `jobs/02-archive/run.py` fetches originals for institutions whose
  current-year `status.json` doesn't yet exist. Resumable by construction.
- **3. Normalize** — `jobs/03-normalize/run.py` extracts text for every archived document
  lacking one.
- **4. Extract** — `make_packets.py` builds one task packet per document lacking a
  current-version extraction; the agent works a packet via its `prompt.md`; `validate.py`
  checks schema, anchoring, and tier before archiving.
- **5. Review** — status only, rendered read-only in the menu. Reviewing itself — by
  volunteers or the operator — happens in the review web app (`jobs/05-review/app/`),
  never in chat, so every decision produces the same `review.json` audit trail.
- **6. Publish** — `jobs/06-publish/rebuild.py` drops and rebuilds the entire catalog from
  the archive. Run after every review batch.

## Preconditions and transitions

- Discover candidates can't be merged until the operator has confirmed them (chat →
  decisions file → `merge.py`).
- Archive only fetches institutions with a confirmed URL (or explicitly records
  `no_url`/`not_found`).
- Normalize only runs on documents that archive has fetched.
- Extract packets are only built for normalized documents lacking a current extraction
  version.
- Review tiers (`fast`/`standard`/`flagged`) are assigned by `validate.py`, not the agent
  or the operator — see `IMPLEMENTATION_PLAN.md` §9.
- Publish is safe to run at any time; it is a pure function of the archive and always
  fully rebuilds rather than incrementally updating.

## What "decisions become files" means in practice

Examples: discover confirmations, review approvals/rejections/corrections, and any
operator override — all are written synchronously to a file in the archive or a job's
`tasks/`/decisions directory by a validating script, never left as only a chat message.
