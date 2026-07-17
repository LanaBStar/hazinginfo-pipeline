# HazingInfo.org CHTR Archival Pipeline — Implementation Plan v2.0

**Handoff document.** This plan is the complete, settled design for a from-scratch rebuild
of the HazingInfo.org pipeline. It was produced through an extended design review; every
decision in it is deliberate. Build what is written here. Do not re-litigate the
architecture, do not add fields, frameworks, or abstractions not specified. Where this
document is silent or ambiguous, **ask the user (Mahir) — do not invent.**

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
5. **Every factual claim is a verbatim quote from the official document**, mechanically
   verified as a substring of the document's extracted text. AI interprets only:
   normalized dates and two booleans.
6. **Human decisions are artifacts.** Approvals, rejections, corrections, and operator
   confirmations become files in the archive, synchronously at decision time. Chat is
   ephemeral; the archive is not.
7. **State is derived, never stored.** Pipeline progress is computed by scanning the
   archive (`status.py`), not tracked in a state store that can drift.
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
│   ├── validation.schema.json         # §7 validate.py output (anchoring results + tier)
│   └── review.schema.json             # §10 review.json
├── jobs/
│   ├── 01-discover/           # RUNBOOK.md, prompt.md, schema.json (candidates.json), merge.py
│   ├── 02-archive/            # RUNBOOK.md, run.py           (crawler ported from old repo)
│   ├── 03-normalize/          # RUNBOOK.md, run.py
│   ├── 04-extract/            # RUNBOOK.md, prompt.md, schema.json, make_packets.py, validate.py
│   ├── 05-review/             # RUNBOOK.md, app/  (Cloudflare Pages + Worker), ingest.py
│   └── 06-publish/            # RUNBOOK.md, rebuild.py, catalog_schema.sql
├── lib/                       # shared: r2.py, fetch.py, text.py, hashing.py, quotes.py
├── fixtures/                  # 3 test institutions: canned HTML/PDFs + expected outputs
└── tests/                     # smoke tests per job
```

**Schema placement rule:** schemas for *AI-job outputs* live inside their job directory
(`01-discover/schema.json` validates candidates.json; `04-extract/schema.json` validates
incidents.json) because they ship inside task packets. Schemas for *cross-job artifacts*
(manifest, status, extraction metadata, validation, review) live in top-level `schemas/`.
Every artifact carries a `schema_version` field, and **any script that writes an artifact
validates it against its schema immediately before writing** — this is how invariant 3
(only validating scripts write) is enforced in practice. Phase 0 delivers all seven
schemas.

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
  "discover":  {"confirmed_urls": 1391, "pending_candidates": 12, "no_url": 81},
  "archive":   {"institutions_done": 1391, "pending": 93, "documents": 2140},
  "normalize": {"pending_documents": 14, "no_text_layer": 63},
  "extract":   {"packets_total": 68, "packets_done": 52, "awaiting_validation": 1},
  "review":    {"fast_lane": 812, "standard": 141, "flagged": 46, "decided": 655},
  "publish":   {"last_rebuild": "2026-06-02", "approved_unpublished": 118}
}
```

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
    {scrape_year}/
      status.json                                # ALWAYS written, even when nothing found
      docs/
        {content_hash[:16]}/
          manifest.json
          original/…                             # report.pdf | index.html + assets/
          extracted/text.txt                     # from 03-normalize (may be empty: scanned PDF)
          ai/
            extract_v{N}/
              incidents.json                     # agent output (archived even if invalid)
              metadata.json                      # model, prompt_version, schema_version, created
              validation.json                    # anchoring results + tier per incident
          reviews/
            {incident_index}_{reviewer-slug}_{ts}.review.json
```

- **Dedup:** key by content hash. Year 2 refetch of an unchanged document → same hash →
  `status.json` references the existing doc path; nothing re-stored, nothing overwritten.
- **manifest.json:** `{source_url, fetched_at, sha256, content_type, size_bytes, unitid, scrape_year}`.
  The archive must be interpretable with no code running (2036 test).
- **status.json (per institution-year):**
  `{unitid, scrape_year, status: "published" | "published_zero" | "not_found" | "no_url", source_url, documents: [content_hash…], fetched_at}`.
- **Extraction outputs are versioned** (`extract_v1/`, `extract_v2/`) — a new prompt never
  overwrites old output.

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

### 02-archive (Python)
- Port the old repo's crawler core (`scraper/scrape.py` + `helpers.py`): keyword
  heuristics (`hazing`, `chtr`, `transparency report`, …), breadth-first, depth ≤ 2,
  ~30-fetch budget per institution, same-domain links prioritized, all PDFs on
  hazing-signal pages followed. This logic is battle-tested — port it, don't redesign it.
- For HTML pages, also fetch same-origin assets needed to render (best-effort).
- Writes originals + manifest.json; writes status.json per institution **including the
  not_found / no_url cases**. Resumable: skips institutions whose status.json for the
  current scrape year already exists.

### 03-normalize (Python)
- Produces `extracted/text.txt` for **every** document: HTML → text, DOCX → text,
  PDF → text-layer extraction attempt. No OCR pipeline — a PDF with no text layer yields
  an empty text.txt, which downstream **auto-flags** its incidents (anchoring can't run).
- Text includes page markers for PDFs (e.g. `\n[[page 3]]\n`) so anchoring can verify
  page hints.

### 04-extract (AI job)
- `make_packets.py` creates one packet per document lacking a current-version extraction:
  `tasks/extract/{unitid}_{hash16}/` containing prompt.md, the original document, text.txt,
  schema.json, metadata stub.
- Agent reads the original (PDFs natively) and produces `incidents.json` per Section 8.
  Classification is part of extraction (`is_chtr`) — there is no separate cleaning job.
- `validate.py` then: (a) strict JSON-schema validation — unknown fields rejected;
  (b) **anchoring**: every quote must fuzzy-substring-match text.txt (normalize
  whitespace; ~95% similarity threshold), page hint checked against page markers;
  (c) assigns tier (Section 9); (d) archives incidents.json + metadata.json +
  validation.json. Invalid output is archived too (marked invalid) and the packet
  reported for re-run — never silently discarded.

### 05-review (Human job) — see Sections 10–11.

### 06-publish (Python)
- `rebuild.py`: `DROP SCHEMA … CASCADE` → recreate from `catalog_schema.sql` → walk the
  entire archive → repopulate. Pure function of the archive. Run after every review batch.

---

## 8. Extraction JSON schema (v1)

The Act defines the fields: organization, description, alcohol/drugs, findings, sanctions,
incident/investigation/resolution dates. Nothing else.

```json
{
  "schema_version": 1,
  "is_chtr": true,
  "document": {
    "title_quote":            {"text": "…", "page": 1},
    "reporting_period_quote": {"text": "January 1 – December 31, 2025", "page": 1},
    "reporting_period_start": "2025-01-01",
    "reporting_period_end":   "2025-12-31",
    "publication_date":       "2026-01-15",
    "zero_incidents_quote":   null
  },
  "incidents": [
    {
      "organization_quote":  {"text": "Zeta Psi Fraternity", "page": 2},
      "description_quote":   {"text": "…", "page": 2},
      "findings_quote":      {"text": "…", "page": 2},
      "sanction_quotes":     [{"text": "…", "page": 3}],
      "alcohol_involved":    true,
      "drugs_involved":      null,
      "dates": {
        "incident_quote":            {"text": "Fall 2025", "page": 2},
        "incident_start":            "2025-09-01",
        "incident_end":              "2025-12-15",
        "investigation_initiated":   "2025-11-02",
        "resolved":                  "2026-01-10"
      }
    }
  ]
}
```

Rules:
- A quote is `{text, page}` — text **verbatim**, page a hint (null for HTML).
  `validate.py` computes offsets itself; never ask the AI for character offsets.
- Everything nullable **except `description_quote`**. Missing `organization_quote` →
  auto-flag (the Act requires it; absence is itself signal).
- `zero_incidents_quote` anchors zero-incident reports to the same evidentiary standard.
- The only AI interpretation: ISO-normalized dates and the two booleans (both must be
  evident from the quoted text on screen).
- **Deliberately excluded** (do not re-add): hazing-type taxonomy, sanction severity
  levels, `location` on/off-campus, `is_aggravated`, `date_reported`, `org_type`.
  Categorical layers, if ever wanted, are computed downstream of verification as
  regenerable derived data — never inside this pipeline.
- The extraction prompt must require page-anchored verbatim quotes from day one
  (retrofitting anchors means re-extracting the entire back catalog).

---

## 9. Anchoring and review tiers

`validate.py` assigns each incident (and each zero-incident report) a tier:

| Tier | Condition | Review policy |
|---|---|---|
| `fast` | zero-incident report with anchored `zero_incidents_quote` | single reviewer, one click |
| `standard` | all quotes anchored AND second-pass AI cross-check agrees on all fields | single reviewer confirms segmentation + booleans + dates |
| `flagged` | any anchoring failure, empty text.txt (scanned PDF), AI cross-check disagreement, missing organization_quote, or sanction quote containing suspension/expulsion | **dual review** (second reviewer or operator sign-off) |

The **cross-check** is a second agent pass (separate session, `04-extract/crosscheck_prompt.md`:
"verify this extraction against this document, field by field, cite pages"). Agreement
orders the queue and pre-highlights likely errors; it never substitutes for the human on
the flagged tier (two AI passes can share a blind spot).

Human review checks exactly two things machines can't: **segmentation** (incidents merged
or split incorrectly) and **interpretation** (booleans, date normalization) — plus, for
scanned documents, that quotes match the page image.

**Calibration:** before trusting single review on the `standard` tier, volunteers
dual-review a shared initial batch of real incidents (there is no legacy system to draw
a pre-built answer-key from). Disagreement rates determine whether single-review on
`standard` is safe.

---

## 10. review.json

```json
{
  "schema_version": 1,
  "extraction_ref": {"file_hash": "sha256-of-incidents.json", "incident_index": 0},
  "tier": "flagged",
  "decision": "approved | rejected | corrected",
  "rejection_reason": "not_hazing | duplicate | segmentation_error | extraction_error",
  "corrections": {"dates.incident_start": "2025-10-01"},
  "reviewer": "…",
  "reviewed_at": "…",
  "second_review": null
}
```

- Archived to R2 **synchronously at decision time** (via the Worker → `ingest.py`
  validation path). Reviews pin the exact extraction file hash: re-extraction under a new
  prompt never silently orphans or reassigns a human decision.
- Corrections to a **quote** re-run anchoring — a corrected quote must still exist in the
  document. Reviewers can never introduce unanchored text.
- Reviewer identity is permanent and reviewers are told so (integrity and their protection).
- Disagreements escalate to the operator.

## 11. Review app

- **Stack:** Cloudflare Pages (static UI) + one Worker (API) + Cloudflare Access for
  login (free ≤ 50 users). Reads from the catalog's queue view; writes review.json to R2
  through the validating Worker. **The app never writes catalog rows** — it is untrusted
  by construction.
- **UX:** one incident per screen; original document as the ground-truth surface (PDF.js /
  sanitized HTML) with anchored quotes pre-highlighted via offsets from validation.json;
  extracted text is the *navigation layer only, never the displayed evidence* (the human's
  job is comparing claims to the real document — reviewing against extracted text would
  close the loop with nothing ever checked against reality). Keyboard-driven:
  approve / fix / escalate. Queue batched by document, ordered fast → standard → flagged.
- Scanned-PDF (flagged) view: page image beside the quotes.

## 12. Catalog (Neon Postgres — rebuilt, never authoritative)

```sql
institutions        (unitid PK, name, state, …)                        -- from schools.csv
documents           (content_hash PK, unitid, storage_key, source_url,
                     fetched_at, scrape_year, has_text_layer)          -- from manifests
reports             (report_id PK, content_hash, period_start, period_end,
                     publication_date, is_zero_incident)               -- from approved extractions
incidents           (incident_id PK, report_id, organization_text, organization_page,
                     description_text, description_page, findings_text, findings_page,
                     alcohol_involved, drugs_involved,
                     incident_date_text, incident_start, incident_end,
                     investigation_initiated, resolved,
                     reviewer, reviewed_at, second_reviewer)           -- extraction + review.json
incident_sanctions  (incident_id, sanction_text, page)
reporting_status    (unitid, scrape_year, status, source_url)          -- from status.json files
```

- `incident_id` = short hash of `unitid | organization_quote | incident_quote |
  description_quote-prefix`. Verbatim quotes make this fingerprint stable: overlapping
  annual reports quote identical text → same id → cross-year dedup falls out for free,
  and public URLs survive every rebuild.
- `report_id` = hash of `content_hash | period_start | period_end`.
- Only `approved`/`corrected` incidents (with corrections applied) enter `incidents`.
  There is no staging schema — staging is files in the archive.

## 14. Fixtures and the annual smoke run

- `fixtures/`: three synthetic institutions — (a) HTML CHTR with 2 incidents, (b) text-layer
  PDF CHTR with 1 incident + one non-CHTR decoy PDF, (c) zero-incident scanned-style PDF
  (no text layer). Include expected extraction outputs and expected tiers.
- Smoke run = full pipeline over fixtures into a `smoke/` archive prefix (never mixed
  with real data). Asserts: manifests written, absence recorded, anchoring passes/fails
  where expected, scanned doc auto-flags, rebuild produces identical ids run-to-run.
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

Order matters: publish (5) before discover (6) so the core loop is provable early; the
review app (7) is the largest item and depends on validation.json offsets from Phase 4.

## 17. The 2036 test (acceptance criterion)

A stranger with only this repo and the R2 archive must be able to:
1. Answer "why does this incident exist?" — following incident_id → review.json →
   incidents.json → text.txt → original → source URL.
2. Rebuild the entire catalog with one script.
3. Operate the next annual run using only OPERATIONS.md and the runbooks.

If any of the three fails, the build is not done.
