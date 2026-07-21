# HazingInfo.org CHTR Archival Pipeline — Implementation Plan v3.0

**Handoff document.** This plan is the complete, settled design for the HazingInfo.org
pipeline. It was produced through an extended design review; every decision in it is
deliberate. Build what is written here. Do not re-litigate the architecture, do not add
fields, frameworks, or abstractions not specified. Where this document is silent or
ambiguous, **ask the user (Mahir) — do not invent.**

**v3.0 supersedes v2.0's catalog design (§12) and its anchoring/tier system (old §9).**
Phases 0–8 were built against v2.0; v3.0 replaces the six-table catalog with a richer
two-schema (`staging`/`public`) design sourced from the "CHTR Data Dictionary" Airtable
base, and drops quote-anchoring/review-tiers in favor of AI-reported
`extraction_confidence` + typed review flags. **[`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md)
is the authoritative field-by-field reference for every table** — this plan describes the
architecture and data flow around it, not a restatement of every column. Migration to v3.0
is tracked as Phases 9+ in `BUILD_STATUS.md`, following the same one-phase-at-a-time
discipline as Phases 0–8.

---

## 0. Instructions to the builder (read first)

- Build in a **new directory** (suggested: `~/Documents/hazinginfo-pipeline/`), initialized
  as a fresh git repo. The old repo (`~/Documents/hazing-incidents/`) is frozen reference
  material — read from it (Phase 2 ports its crawler), never modify it.
- Work in **phases** (Section 16). Each phase is sized to fit one working session.
  Maintain `BUILD_STATUS.md` at the repo root: a checklist of phases and their state,
  updated at the end of every session, so any fresh session can resume with zero
  conversational context.
- End every phase by running its smoke check against `fixtures/` (Section 14).
- Plain Python 3, stdlib + minimal deps (`requests`, `beautifulsoup4`, `pypdf` or
  `pdfplumber` for text-layer extraction, `psycopg`, `boto3` for R2). **No frameworks**:
  no LangChain, no task queues, no ORMs, no migration frameworks, no vector DBs.
- Secrets live in `.env` (never committed, never printed). Ask the user for R2 and Neon
  credentials when a phase first needs them.

---

## 1. Mission and context

The Stop Campus Hazing Act requires U.S. institutions to publish Campus Hazing
Transparency Reports (CHTRs): the organization involved, a description of the violation,
whether alcohol/drugs were involved, findings, sanctions, and key dates. Institutions
publish these inconsistently, on pages that move and vanish, with no aggregation.

HazingInfo.org is the independent public archive: it discovers CHTRs across **1,484
tracked institutions**, preserves the original publications permanently, extracts
incidents into structured data, and publishes only what a human has verified against the
original document.

**Ethics, in one sentence:** every published incident names real organizations and
describes misconduct, so a hallucinated or mis-attributed incident is potentially
defamatory — the entire architecture exists to make that structurally impossible.

**The 2036 test:** a developer ten years from now must be able to trace any published
incident backward — production row → review.json → extraction file → extracted text →
original document → source URL — using nothing but the archive. Every design decision
serves this chain.

**Operating constraints:** one technical operator, volunteer reviewers, annual cadence,
budget = one Claude subscription (no AI API keys), Cloudflare R2 + free-tier Workers/Pages,
Neon Postgres free tier.

---

## 2. Non-negotiable invariants

1. **R2 archive is the sole source of truth. Postgres is a disposable projection.**
   The archive is append-only and immutable: never overwrite, never delete.
2. **Rebuild is the only write path to production.** The publish job drops and rebuilds
   the catalog from the archive, every time. There is no incremental import. This proves
   the archive is sufficient on every single publish.
3. **The AI (agent) holds no write credentials.** Agents produce candidate files; only
   validating Python scripts write to R2 or the catalog. This one mechanical rule replaces
   all aspirational "never let AI do X" rules.
4. **Every input the AI saw is archived.** (Replaces "AI never sees originals" — the agent
   MAY read PDFs natively; what matters is that its exact input is preserved.)
5. **Every factual claim is grounded in the official document and reviewed by a human
   before publication.** (v3.0: replaces verbatim-quote anchoring as the evidentiary
   mechanism.) The AI reports raw extracted text alongside every normalized/interpreted
   field (dates, alcohol/drugs involvement, determination status, organization name and
   type) plus its own per-incident `extraction_confidence` and a structured `flags[]`
   array naming anything it's unsure of. Nothing reaches `public` without a human
   `Approved` decision in `staging` — see §9.
6. **Human decisions are artifacts.** Approvals, rejections, corrections, and operator
   confirmations become files in the archive, synchronously at decision time. Chat is
   ephemeral; the archive is not.
7. **State is derived, never stored.** Pipeline progress is computed by scanning the
   archive (`status.py`), not tracked in a state store that can drift. (v3.0: this is why
   organization matching, cross-year incident-status updates, and flag resolution are all
   recomputed by `rebuild.py` from the archive on every publish, not written as separate
   R2 artifacts of their own — see §9.)
8. **Absence is data.** An institution that published nothing gets a `status.json` for
   that year. Compliance-rate claims depend on recorded absence.
9. **IDs are content-derived, never SERIAL.** Rebuilds must be idempotent: identical
   archive → identical catalog, including every public ID.
10. **Parameterized SQL only. Every script idempotent and resumable.**

---

## 3. Architecture overview

There is no workflow engine. The "harness" is three conventions:

1. **Every job is a directory** with a `RUNBOOK.md` (prose runbook: purpose,
   preconditions, steps, postconditions, failure modes), plus `prompt.md` +
   `schema.json` for AI jobs and plain scripts for deterministic work.
2. **The agent is the console.** The operator opens Claude Cowork or Codex on the repo;
   the boot file (`CLAUDE.md` / `AGENTS.md`) instructs the agent to run `status.py` and
   render an interactive menu. The operator navigates by conversation; the agent executes
   runbooks, asks questions, and fills AI task packets.
3. **`status.py` computes all state** from the archive and prints JSON. The menu is
   always a fresh rendering of its output.

Pipeline flow:

```
sources/schools.csv (1,484 institutions, versioned in repo)
        │
  01-discover    agent: verify/find CHTR URLs → candidates file → human confirms → merge.py
        │        (v3.0: + cross-check against the Airtable schools-registry base — §7)
  02-archive     python: fetch originals + assets → R2 (manifest.json per doc, status.json
        │        per school-year, ledger entry per URL, data_check per institution-cycle)
  03-normalize   python: extracted text for every document (incl. PDF text layers) → R2
        │
  04-extract     agent packets: is_chtr + incidents.json (raw+normalized fields, per-incident
        │        extraction_confidence + flags[], organization proposal) → validate.py
        │        (schema conformance only, v3.0) → R2
  05-review      volunteers via web app → review.json (single-reviewer decision + per-field
        │        corrections + organization decision) → R2   (operator reviews in the SAME app)
  06-publish     python: full catalog rebuild from R2 → Neon (staging + public schemas,
                 organization matching, cross-year incident-status resolution) → public site
```

---

## 4. Repository layout

```
hazinginfo-pipeline/
├── CLAUDE.md                  # boot file (Cowork)
├── AGENTS.md                  # boot file (Codex) — both point at OPERATIONS.md
├── OPERATIONS.md              # the state machine in prose: menu items, preconditions, transitions
├── BUILD_STATUS.md            # build-phase checklist (builder maintains)
├── status.py                  # derived pipeline state → JSON
├── sources/
│   └── schools.csv            # unitid, name, state, chtr_url, url_status, evidence — version-controlled scope
├── schemas/                   # cross-job artifact schemas (JSON Schema draft 2020-12, one per artifact type)
│   ├── manifest.schema.json           # §6 manifest.json
│   ├── status.schema.json             # §6 status.json (institution-year)
│   ├── extract_metadata.schema.json   # §6 ai/…/metadata.json
│   ├── validation.schema.json         # §7 validate.py output (schema conformance only, v3.0)
│   ├── ledger_entry.schema.json       # §6 ledger/{url_hash16}.json (v3.0)
│   ├── data_check.schema.json         # §6 data_check.json per institution-cycle (v3.0)
│   ├── pipeline_run.schema.json       # §6 pipeline_runs/{run_id}.json (v3.0)
│   └── review.schema.json             # §10 review.json
├── jobs/
│   ├── 01-discover/           # RUNBOOK.md, prompt.md, schema.json (candidates.json), merge.py
│   ├── 02-archive/            # RUNBOOK.md, run.py           (crawler ported from old repo)
│   ├── 03-normalize/          # RUNBOOK.md, run.py
│   ├── 04-extract/            # RUNBOOK.md, prompt.md, schema.json, make_packets.py, validate.py
│   ├── 05-review/             # RUNBOOK.md, app/  (Cloudflare Pages + Worker), ingest.py
│   └── 06-publish/            # RUNBOOK.md, rebuild.py, catalog_schema.sql
├── lib/                       # shared: r2.py, fetch.py, text.py, hashing.py
│                              #   (v3.0: quotes.py removed in Phase 14 — no more anchoring)
├── fixtures/                  # 3 test institutions: canned HTML/PDFs + expected outputs
└── tests/                     # smoke tests per job
```

**Schema placement rule:** schemas for *AI-job outputs* live inside their job directory
(`01-discover/schema.json` validates candidates.json; `04-extract/schema.json` validates
incidents.json) because they ship inside task packets. Schemas for *cross-job artifacts*
(manifest, status, extraction metadata, validation, ledger entry, data check, pipeline
run, review) live in top-level `schemas/`. Every artifact carries a `schema_version`
field, and **any script that writes an artifact validates it against its schema
immediately before writing** — this is how invariant 3 (only validating scripts write) is
enforced in practice.

**Nothing new is stored just because Postgres has a table for it.** Per invariant 7,
organization matching, cross-year incident-status resolution, and review-flag
resolution are all *derived* by `rebuild.py` at publish time from the incidents.json /
review.json artifacts above — none of them get their own R2 file. See §9.

---

## 5. Console specification

`CLAUDE.md` / `AGENTS.md` (near-identical, vendor-specific header only) must instruct:

> You are the operator console for the HazingInfo pipeline. On session start and before
> every menu render, run `python status.py` and format its JSON as a numbered menu.
> You may do exactly three things: (1) execute scripts named in a job's RUNBOOK.md,
> (2) perform the AI work defined by a task packet's prompt.md, (3) ask the operator
> questions. Never edit archive or catalog data directly, never improvise steps not in a
> runbook, never answer "what's the pipeline state?" from memory. Any operator decision
> that affects data must be written to a file that a script reads — a chat answer is not
> a decision.

**The three console rules (verbatim, in OPERATIONS.md):**

1. **The menu is computed, never remembered.** Every render = fresh `status.py` call.
2. **The agent does only three things**: run runbook scripts, execute packet prompts,
   ask questions.
3. **Chat is ephemeral; decisions become files.**

`status.py` output (shape, not exhaustive):

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

(v3.0: `review` drops the tier-based counts (`fast_lane`/`standard`/`flagged`/
`escalated_pending`) since there are no more tiers or dual review — it now reports
incident-review and organization-review queues separately, since those are decided
independently per §9. `discover` gains `airtable_mismatches` from the new cross-check
step. `extract` gains `low_confidence` as an informational count, not a routing tier.)

**Mandatory rule:** if `smoke_run.done_this_year` is false, the menu's first item is the
fixtures smoke run, and OPERATIONS.md forbids starting the annual pass before it.

The review queue appears in the menu as **read-only status**. Reviewing never happens in
chat — the operator uses the same web app as volunteers, producing the same review.json
audit trail.

---

## 6. Archive layout (R2)

Institution-first, scrape-year second (reporting period is unknown until extraction):

```
archive/
  {unitid}_{school-slug}/
    ledger/
      {url_hash16}.json                          # v3.0: one per distinct URL ever seen, across years
    {scrape_year}/
      status.json                                # ALWAYS written, even when nothing found
      data_check.json                            # v3.0: one per institution per scrape cycle
      docs/
        {content_hash[:16]}/
          manifest.json
          original/…                             # report.pdf | index.html + assets/
          extracted/text.txt                     # from 03-normalize (may be empty: scanned PDF)
          ai/
            extract_v{N}/
              incidents.json                     # agent output (archived even if invalid) — v3.0 shape, see §8
              metadata.json                      # model, prompt_version, schema_version, created
              validation.json                    # v3.0: schema conformance only (no anchoring/tier)
          reviews/
            {incident_index}_{reviewer-slug}_{ts}.review.json   # v3.0 shape, see §10
pipeline_runs/
  {run_id}.json                                  # v3.0: one per batch run, not institution-scoped
```

- **Dedup:** key by content hash. Year 2 refetch of an unchanged document → same hash →
  `status.json` references the existing doc path; nothing re-stored, nothing overwritten.
- **manifest.json:** `{source_url, fetched_at, sha256, content_type, size_bytes, unitid, scrape_year}`.
  The archive must be interpretable with no code running (2036 test).
- **status.json (per institution-year):**
  `{unitid, scrape_year, status: "published" | "published_zero" | "not_found" | "no_url", source_url, documents: [content_hash…], fetched_at}`.
- **Extraction outputs are versioned** (`extract_v1/`, `extract_v2/`) — a new prompt never
  overwrites old output.
- **ledger/{url_hash16}.json** (v3.0, per `Ledger` in `DATABASE_SCHEMA.md`): `{schema_version,
  unitid, source_url, fingerprint_content_hash, first_seen_date, last_seen_date}`. Content
  hash is computed from fetched text *after* stripping boilerplate/date tokens (full
  dates, ranges, bare years, phrases like "this reporting period") — this is what lets an
  unchanged annual re-post of the same "no violations" boilerplate register as unchanged
  even though the embedded date differs, per the data dictionary's own
  "Boilerplate/date-token stripping before hashing" pipeline-logic entry. This is the one
  file in the archive that's updated in place rather than written once — it's bookkeeping
  metadata for dedup, not archived content, so invariant 1's append-only rule doesn't
  apply to it (only `last_seen_date`/`fingerprint_content_hash` ever change on a re-seen
  URL; `first_seen_date` is fixed at creation).
- **data_check.json** (v3.0, per `Data_checks`): `{schema_version, unitid, scrape_year,
  chtr_index_url, checked_by, data_check_date, pipeline_status}`. Written unconditionally
  for every institution every scrape cycle (§7's 01-discover cross-check step resolves
  `chtr_index_url`/`checked_by` before this is written).
- **pipeline_runs/{run_id}.json** (v3.0, per `Pipeline-runs`): `{schema_version, run_id,
  prompt_version, run_status, run_started_at, run_completed_at}`. One per batch invocation
  of 02-archive or 04-extract; not institution-scoped, so it lives at the archive root
  alongside (not under) `archive/`, the same way the `smoke/` prefix does.

---

## 7. Job specifications

### 01-discover (AI job)
- **Input:** `sources/schools.csv`. **Packets:** batches of ~25–50 schools
  (`tasks/discover/{batch}/` with prompt.md + slice of CSV). Batching is mandatory —
  the annual pass spans multiple sessions and must resume cleanly.
- Agent searches the web for each school's official CHTR URL, emits a **separate
  candidates file** (`candidates.json`: unitid, proposed_url, confidence, evidence quote)
  — it never edits schools.csv in place.
- Operator confirms candidates via the console; confirmations are written to a decisions
  file; `merge.py` validates (URL well-formed, unitid exists, no row deletion) and merges
  into schools.csv.
- **v3.0 — Airtable cross-check:** after `merge.py` confirms a URL, look up that
  institution by `unitid` in the existing schools-registry Airtable base
  (`AIRTABLE_TOKEN`/`AIRTABLE_BASE_ID`/`AIRTABLE_TABLE_NAME`) and compare its
  `Transparency Report` field against the just-confirmed `chtr_url`. The agent-discovered
  URL remains what gets scraped (it is not overwritten by Airtable, nor does it overwrite
  Airtable) — a mismatch is written to a review file for operator attention, not silently
  resolved either way. This is what resolves `data_check.json`'s `chtr_index_url` (§6):
  the merged `schools.csv` value, annotated with whether it was cross-checked and
  matched.

### 02-archive (Python)
- Port the old repo's crawler core (`scraper/scrape.py` + `helpers.py`): keyword
  heuristics (`hazing`, `chtr`, `transparency report`, …), breadth-first, depth ≤ 2,
  ~30-fetch budget per institution, same-domain links prioritized, all PDFs on
  hazing-signal pages followed. This logic is battle-tested — port it, don't redesign it.
- For HTML pages, also fetch same-origin assets needed to render (best-effort).
- Writes originals + manifest.json; writes status.json per institution **including the
  not_found / no_url cases**. Resumable: skips institutions whose status.json for the
  current scrape year already exists.
- **v3.0:** also writes/updates `ledger/{url_hash16}.json` for every URL fetched
  (boilerplate-stripped content fingerprint, §6) and `data_check.json` once per
  institution per cycle. Writes a `pipeline_runs/{run_id}.json` record at the start of a
  batch run and marks it complete at the end (`run_status: "running" | "complete" |
  "partial_error"`), mirroring `Data_checks.pipeline_status`'s own retry semantics: a
  retried institution updates its `data_check.json`'s `pipeline_run_id` to the retry's
  run, since that file is "most recently touched by," but the underlying `manifest.json`
  for any document already stored keeps pointing at the run that actually created it —
  never repointed by a later retry.

### 03-normalize (Python)
- Produces `extracted/text.txt` for **every** document: HTML → text, DOCX → text,
  PDF → text-layer extraction attempt. No OCR pipeline — a PDF with no text layer yields
  an empty text.txt; the extraction agent reports low/no confidence for anything it can't
  read off an image-only page, which surfaces as a flag (§9) rather than an anchoring
  failure.
- Text still includes page markers for PDFs (e.g. `\n[[page 3]]\n`) — unchanged in v3.0,
  since they're still useful for the reviewer's own PDF navigation, even though nothing
  downstream anchors a field to a specific page anymore.

### 04-extract (AI job)
- `make_packets.py` creates one packet per document lacking a current-version extraction:
  `tasks/extract/{unitid}_{hash16}/` containing prompt.md, the original document, text.txt,
  schema.json, metadata stub.
- Agent reads the original (PDFs natively) and produces `incidents.json` per Section 8.
  Classification is part of extraction (`is_chtr`) — there is no separate cleaning job.
- `validate.py` (v3.0 — no anchoring, no tier): (a) strict JSON-schema validation —
  unknown fields rejected; (b) archives incidents.json + metadata.json + validation.json
  (now just `{schema_version, valid, schema_errors}` — see §9). Invalid output is
  archived too (marked invalid) and the packet reported for re-run — never silently
  discarded.

### 05-review (Human job) — see Sections 10–11.

### 06-publish (Python)
- `rebuild.py`: `DROP SCHEMA … CASCADE` on both `staging` and `public` → recreate from
  `catalog_schema.sql` → walk the entire archive → repopulate all 15 tables (§12). Pure
  function of the archive (+ the Airtable cross-check note already folded into
  `data_check.json`, not read live from Airtable at publish time). Run after every review
  batch.

---

## 8. Extraction JSON schema (v3.0 — supersedes the v2.0/v1 shape below `Staging_incidents`
   + `Staging_organizations` in `DATABASE_SCHEMA.md`)

The Act defines the fields: organization, description, alcohol/drugs, findings, sanctions,
incident/investigation/resolution dates. v3.0 adds `determination_status`, an
organization *proposal* (name + type, for matching against the public `Organizations`
registry), and a self-reported `extraction_confidence` + `flags[]` per incident, in place
of v2.0's page-anchored quote objects.

```json
{
  "schema_version": 2,
  "is_chtr": true,
  "document": {
    "reporting_period_start":  "2025-01-01",
    "reporting_period_end":    "2025-12-31",
    "publication_date":        "2026-01-15",
    "zero_incidents_statement": null
  },
  "incidents": [
    {
      "organization_name_raw":        "Zeta Psi Fraternity, Beta Chapter",
      "organization_name_normalized": "Zeta Psi",
      "organization_type":            "Fraternity",
      "description_raw":              "…",
      "findings_raw":                 "…",
      "sanctions_raw":                "…",
      "alcohol_involved":             "Yes",
      "drugs_involved":               "Not specified",
      "determination_status":         "Determined hazing",
      "dates": {
        "incident_start_raw":  "Fall 2025", "incident_start_normalized": "2025-09-01", "incident_start_precision": "Academic term",
        "incident_end_raw":    "…",         "incident_end_normalized":   "2025-12-15", "incident_end_precision":   "Day",
        "investigation_start_date_raw": "…", "investigation_start_date": "2025-11-02",
        "investigation_end_date_raw":   "…", "investigation_end_date":   "2026-01-05",
        "notice_date_raw":              "…", "notice_date":              "2026-01-10"
      },
      "extraction_confidence": 0.92,
      "flags": [
        {"flag_type": "Alcohol/drugs review needed", "field_name": "alcohol_involved", "note": null}
      ]
    }
  ]
}
```

Rules:
- Every raw field is captured **verbatim** from the source; every normalized field is the
  AI's ISO/controlled-vocabulary interpretation of that same raw text. `validate.py` no
  longer computes or checks character offsets — see §9 for what replaced anchoring.
- Everything nullable **except `description_raw`**. Missing `organization_name_raw` →
  a `flags[]` entry with `flag_type: "Required field missing"` (the Act requires it;
  absence is itself signal).
- `zero_incidents_statement` (raw text) is the zero-incident-report equivalent of
  `description_raw` — required whenever `incidents` is empty and `is_chtr` is true.
- `organization_name_normalized` and `organization_type` are proposals: `rebuild.py`
  decides at publish time whether they match an existing public `Organizations` row
  (deterministic lowercase/trim/punctuation-strip compare, per `DATABASE_SCHEMA.md`'s
  "Organization name: AI cleans, pipeline copies + safety net" pipeline-logic entry) or
  become a new one, pending its own independent review (§9). Extraction never asserts a
  final `organization_id`.
- `alcohol_involved`/`drugs_involved` are independent controlled-vocab fields
  (`Yes`/`No`/`Not specified`), never a single combined boolean — see
  `DATABASE_SCHEMA.md`'s extraction-disambiguation rule for the three source patterns
  (separate fields / one combined field / narrative-only) and when a combined-and-
  affirmative source triggers an `"Alcohol/drugs review needed"` flag.
- `extraction_confidence` is per-incident (not document-level, correcting the open
  question `DATABASE_SCHEMA.md` flagged against Mahir's original prompt). `<0.7` is the
  provisional threshold for a `"Low extraction confidence"` flag — pipeline code applies
  the threshold, the model only reports the score.
- **Deliberately excluded** (unchanged from v2.0 — do not re-add): hazing-type taxonomy,
  sanction severity levels, `location` on/off-campus, `is_aggravated`, `date_reported`.
  Categorical layers, if ever wanted, are computed downstream of verification as
  regenerable derived data — never inside this pipeline.

---

## 9. Review model, organization matching, and cross-year status (v3.0 — replaces the
   anchoring/tier system)

There are no more review tiers and no more dual review. Every incident and every
organization proposal gets exactly one human decision
(`Pending review → Approved | Rejected`, or `Approved → corrected-and-Approved`), the
same policy regardless of confidence — `extraction_confidence` and `flags[]` are signal
for the reviewer's attention, not a routing mechanism. `validate.py` no longer decides
anything about review policy; it only checks schema conformance (§7).

**Flags** (`Staging_incident_review_flags` in `DATABASE_SCHEMA.md`) are how the AI
surfaces uncertainty: `Required field missing`, `Alcohol/drugs review needed`,
`Determination unclear`, `Low extraction confidence` (<0.7, provisional), `Unrecognized
date term`, `Unable to determine organization type`. The model reports the condition; a
recheck of whether the condition still holds after a correction is applied is recomputed
by `rebuild.py` on every rebuild (per invariant 7 — nothing is stored that can be
derived), not tracked as a separate stateful event.

**Organization matching** happens at publish time, not extraction time: `rebuild.py`
takes each approved incident's `organization_name_normalized`, applies a final
deterministic compare (lowercase, trim, strip punctuation, comparison-only — never
changes what's stored) against the public `Organizations` registry, and either links the
existing row or proposes a new one. A new organization proposal gets its own,
independent review decision (approve/reject the *organization*, separate from approving
the *incident* that named it) — the review app surfaces both in the same screen (per
`DATABASE_SCHEMA.md`'s "Human review: incidents and organizations together, in context"),
but they can resolve in either order.

**Cross-year incident matching:** before an approved incident is promoted, `rebuild.py`
looks up existing public `Incidents` by two keys — `unitid + investigation_end_date`
(primary) or `unitid + organization + incident_start_date` (secondary, catches incidents
still `Pending` with no end date yet). A hit means this is either the same incident being
re-extracted (`determination_status` unchanged → no-op, already published) or a real
status update (`determination_status` changed → update the existing `Incidents` row in
place and write an `Incident_status_history` entry, rather than inserting a new row).
This is what lets a `Pending` incident found in scrape year 1 resolve to `Determined
hazing` when re-scraped in year 2, without creating a duplicate public record.

---

## 10. review.json (v3.0 — no tier, no escalation, no second_review)

```json
{
  "schema_version": 2,
  "extraction_ref": {"file_hash": "sha256-of-incidents.json", "incident_index": 0},
  "decision": "approved | rejected | corrected",
  "rejection_reason": "not_hazing | duplicate | segmentation_error | extraction_error",
  "corrections": [
    {"field_name": "dates.incident_start_normalized", "original_value": "2025-09-01", "corrected_value": "2025-10-01", "correction_type": ["Minor cleanup"]}
  ],
  "organization_review": {"decision": "approved | rejected | corrected", "corrected_organization_type": null},
  "reviewer": "…",
  "reviewed_at": "…"
}
```

- Archived to R2 **synchronously at decision time** (via the Worker → `ingest.py`
  validation path). Reviews pin the exact extraction file hash: re-extraction under a new
  prompt never silently orphans or reassigns a human decision.
- `corrections` is now a **list, one entry per changed field** (matching
  `Staging_incident_corrections`'s one-row-per-field grain), not a dotted-path dict —
  this is the raw material for measuring which fields the AI gets wrong most often.
  Only fields actually changed in a save get an entry.
- `organization_review` is optional and independent of `decision`: the incident and its
  proposed organization can each be approved/rejected/corrected without waiting on the
  other (§9). `null` means this screen's reviewer didn't touch the organization decision
  (e.g. it was already resolved by an earlier review of a different incident naming the
  same organization).
- There is no more anchoring to re-run on a correction — a corrected value is just text
  or a normalized date/enum; `rebuild.py` applies it as-is when building the public row.
- Reviewer identity is permanent and reviewers are told so (integrity and their
  protection). There is no escalation path or second reviewer in v3.0 — a reviewer who
  can't decide leaves the item `Pending review` for another volunteer or the operator,
  rather than routing through a formal escalation decision.

## 11. Review app

- **Stack:** Cloudflare Pages (static UI) + one Worker (API) + Cloudflare Access for
  login (free ≤ 50 users). Reads the archive directly (never Postgres — the catalog only
  ever holds already-published rows, so there's no "pending" projection to read a queue
  from there); writes review.json to R2 through the validating Worker. **The app never
  writes catalog rows** — it is untrusted by construction.
- **UX:** one incident per screen, its organization proposal shown alongside for the same
  reviewer to decide in the same pass (§9); original document as the ground-truth surface
  (PDF.js / sanitized HTML). Extracted text is the *navigation layer only, never the
  displayed evidence* — the human's job is comparing claims to the real document. Best-
  effort text-search highlighting of quoted spans may still be shown as a visual aid, but
  it is cosmetic only — there is no `validation.json` anchoring authority behind it in
  v3.0, so it must never be described as verifying anything. Keyboard-driven:
  approve / fix / reject. Queue ordered by document, then by `extraction_confidence`
  ascending within a document (lowest-confidence items surfaced first) rather than by
  tier.
- Scanned-PDF view: page image beside the fields, same as before — nothing to
  highlight when there's no text layer, and a note says so.

## 12. Catalog (Neon Postgres — rebuilt, never authoritative) — v3.0

The catalog is now two Postgres **schemas**, both fully dropped and rebuilt from the
archive on every publish (invariant 2 unchanged — see §9 for what "rebuild" now derives
that it didn't before): `staging` (candidate incidents/organizations awaiting review) and
`public` (only reviewer-approved data). **`DATABASE_SCHEMA.md` is the authoritative
field-by-field reference for all 15 tables** — `Institution`, `Pipeline-runs`,
`Data_checks`, `Ledger`, `Artifacts`, `Incidents`, `Incident_organizations`,
`Incident_dates`, `Incident_status_history`, `Organizations` in `public`;
`Staging_incidents`, `Staging_organizations`, `Staging_incident_possible_matches`,
`Staging_incident_review_flags`, `Staging_incident_corrections` in `staging`. This
section only covers what changed structurally from v2.0, not a restatement of columns.

- **No more `reports`/`incident_sanctions` tables.** The new schema has no document-level
  concept (reporting period, publication date, is-zero-incident) at all — it's
  incident-centric, with `Artifacts` as the only document-level row (format + content
  hash, no reporting-period business fields). `sanctions_raw` is a single text field on
  the incident, not a separate sanctions table. Document-level fields extracted per §8
  (`reporting_period_start/end`, `publication_date`, `zero_incidents_statement`) stay
  **archive-only** (in `incidents.json`'s `document` object) — they have no catalog
  column in v3.0. If this turns out to matter for the public site, it's a schema
  extension to raise with Mahir, not something to add unilaterally here.
- **Zero-incident document review still happens but writes no catalog row.** A reviewer
  still confirms a `zero_incidents_statement` is genuine (§10/§11, `incident_index: null`
  review, unchanged) — but since there's no `reports` table to insert into, that review's
  only effect is the R2 audit trail itself. Invariant 8 ("absence is data") is already
  satisfied independently by `status.json`/`data_check.json`, which exist regardless of
  incident count.
- **`incident_id`** = short hash of `unitid | organization_name_normalized |
  incident_start_raw | description_raw-prefix`, computed from the **original, uncorrected**
  staging extraction that first created the incident — frozen forever, exactly like
  `Incidents.staging_incident_id` is frozen at original promotion (`DATABASE_SCHEMA.md`).
  A later `determination_status` update (§9) updates the row in place; the id never
  changes.
- **`organization_id`** = short hash of the organization's final deterministic comparison
  key (lowercase, trimmed, punctuation-stripped `organization_name_normalized`) — new,
  since v2.0 had no `Organizations` table. Hashing the comparison key rather than the
  first-seen proposal's exact text keeps this idempotent regardless of which incident's
  proposal `rebuild.py` happens to process first in a given run (invariant 9).
- Only `Approved`/corrected-and-`Approved` incidents enter `public.Incidents`; only
  `Approved`/corrected-and-`Approved` organization proposals enter `public.Organizations`.
  Everything else (including all of `staging`) is a disposable projection of the archive,
  same as v2.0 — there is still no independently-authoritative staging schema.

## 14. Fixtures and the annual smoke run

- `fixtures/`: synthetic institutions covering — (a) HTML CHTR with 2 incidents, (b)
  text-layer PDF CHTR with 1 incident + one non-CHTR decoy PDF, (c) zero-incident
  scanned-style PDF (no text layer), (d) *(v3.0)* a repeat organization across two
  documents (exercises organization matching), (e) *(v3.0)* the same institution/
  organization across two scrape years with a changed `determination_status` (exercises
  cross-year incident-status resolution). Include expected extraction outputs — no more
  "expected tiers" since tiers don't exist in v3.0.
- Smoke run = full pipeline over fixtures into a `smoke/` archive prefix (never mixed
  with real data). Asserts: manifests written, absence recorded, scanned doc's empty
  text.txt yields no flags-that-need-anchoring (there's nothing to anchor in v3.0 — a
  scanned doc just has low/no extractable raw text for the reviewer to judge against the
  page image), organization matching converges to one `organization_id` across both
  documents, a status-history entry is written on the cross-year case, and rebuild
  produces identical ids run-to-run.
- `status.py` reports whether the smoke run happened this calendar year; OPERATIONS.md
  makes it the mandatory first step of every annual pass. It tests the scripts **and the
  prose** — stale runbooks surface here, not mid-run.

## 15. Security and credentials

- `.env`: R2 keys (write-capable, used ONLY by scripts), Neon URL, Cloudflare tokens.
- The agent/console never receives write credentials; scripts loaded from the repo do the
  writing after validation. The review Worker holds its own narrowly-scoped R2 write
  token (reviews/ prefix only).
- Review app behind Cloudflare Access; reviewer identity from the Access JWT.

## 16. Build phases (one session each; update BUILD_STATUS.md every session)

| Phase | Deliverable | Smoke check |
|---|---|---|
| 0 | Repo scaffold, CLAUDE.md/AGENTS.md, OPERATIONS.md, all JSON schemas, BUILD_STATUS.md, fixtures/ | schemas validate the example documents in this plan |
| 1 | `status.py` + `lib/` (r2, hashing, fetch, text) | correct JSON against a hand-made mini archive |
| 2 | 02-archive: crawler ported from old repo + manifests + status.json | fixtures crawl → correct archive layout, absence recorded |
| 3 | 03-normalize + `lib/quotes.py` (anchoring) | page markers correct; known quotes anchor; scanned fixture yields empty text |
| 4 | 04-extract: make_packets.py, prompt.md, crosscheck_prompt.md, validate.py + tiers | agent-run packet on fixtures → validated, tiered, archived |
| 5 | 06-publish: catalog_schema.sql + rebuild.py | rebuild twice → byte-identical ids; fixture incidents appear |
| 6 | 01-discover: prompt.md, packets, merge.py | candidate → confirm → merge round-trip on a schools.csv copy |
| 7a | Review Worker + ingest.py (review.json write path) | review.json lands in R2, validated, pinned to extraction hash |
| 7b | Review UI (Pages + PDF.js + highlights + Access) | fixture incident reviewable end-to-end |
| 9 | v3.0 migration docs: this file, OPERATIONS.md, BUILD_STATUS.md rewritten for the new schema | no smoke check — pure documentation |
| 10 | Schemas: retire validation.schema.json's anchoring shape; reshape 04-extract/schema.json + review.schema.json; add ledger_entry/data_check/pipeline_run schemas | schemas validate updated `fixtures/schema_examples/` |
| 11 | 02-archive: Ledger fingerprinting, Data_checks, Pipeline-runs | fixtures crawl → ledger/data_check/pipeline_run records written correctly |
| 12 | 01-discover: Airtable cross-check step | confirmed URL cross-checked against Airtable, mismatch surfaced, neither source overwritten |
| 13 | 03-normalize compatibility confirmation | existing smoke check still passes unchanged alongside Ledger |
| 14 | 04-extract: drop anchoring/tiers from validate.py; new incidents.json shape; organization matching; cross-year possible-match detection | fixtures → schema-valid extraction, confidence/flags present, org match + possible-match detected |
| 15 | 05-review: ingest.py/ingest.ts per-field corrections + flags; Pages UI drops tiers, adds organization screen | fixture incident + organization reviewable end-to-end |
| 16 | 06-publish: new catalog_schema.sql (15 tables, 2 schemas) + rebuild.py | rebuild twice → byte-identical ids across all 15 tables |
| 17 | Fixtures + full smoke re-run | every `tests/test_phase*.py` + worker `npm test` pass against the new schema |

Order matters: publish (5) before discover (6) so the core loop is provable early; the
review app (7) is the largest item and depends on validation.json offsets from Phase 4.
Phases 9+ (v3.0 migration) run in the same order they're listed: docs before schemas
before jobs, publish (16) last since it depends on every upstream reshape.

## 17. The 2036 test (acceptance criterion)

A stranger with only this repo and the R2 archive must be able to:
1. Answer "why does this incident exist?" — following incident_id → review.json →
   incidents.json → text.txt → original → source URL.
2. Rebuild the entire catalog with one script.
3. Operate the next annual run using only OPERATIONS.md and the runbooks.

If any of the three fails, the build is not done.
