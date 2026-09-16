# CHTR Database Schema — Data Dictionary

> **Source of truth.** This file is a mechanical export of the "CHTR Data Dictionary" Airtable
> base (tabs: Data Dictionary, Pipeline Logic, Controlled Vocabularies), pulled via the Airtable
> API on 2026-07-18. It documents the two-schema (`public` / `staging`) Postgres catalog design
> that `jobs/06-publish/catalog_schema.sql` and `rebuild.py` implement (see `CLAUDE.md`'s
> "Catalog" section for the behavior). Treat this file as authoritative for the field-level
> design. This was a one-time export, not a live sync: the Airtable connection used to pull it
> was intentionally disconnected afterward, and there is no pull script in this repo --
> refreshing this file means re-pulling from the Airtable base by hand and re-exporting. Where
> `catalog_schema.sql` intentionally deviates from a field table here (ID typing, nullability),
> that file's own header comment explains why.
>
> **Updated again August 17, 2026 (second pass)**: the `Required field missing` flag_type was renamed to
> `Legally required field missing` and scoped strictly to the elements the Stop Campus Hazing Act requires
> an institution to publish; a new `Unable to derive value` flag_type was added for derivation failures on
> our side; the incident END date no longer writes any flag; and `organization_name_raw`/
> `organization_name_normalized` nullability was corrected to Yes to match the shipped schemas.
>
> **Manually updated August 17, 2026** to reflect a substantial extraction-schema pass: the
> `organization_type` vocabulary was replaced (12 terms -> 18), two new fields were added
> (`membership_gender_composition`, `institutional_recognition_status`), `Incident_dates` was
> redesigned to support multiple occurrences per incident with six new granularity columns
> (replacing the calendar-anchor convention below, which is superseded), and every `_raw`-named
> field's nullability was corrected. This update was done by hand against the current
> `catalog_schema.sql`/`prompt.md`/Data Dictionary -- not a re-export -- so treat it as accurate
> as of this date but subject to the same "not a live sync" caveat as the rest of this file.

## How the schema is laid out

The database is split into two Postgres schemas: **`staging`**, which holds AI-extracted
candidate records pending human review, and **`public`**, which holds only reviewer-approved,
canonical data. Nothing reaches `public` without a human `human_review_status = Approved` decision
in `staging` first — this is the single gate the whole design is built around.

**Ingestion (schema: public).** `Institution` is the fixed ~1,484-row roster (IPEDS `unitid`).
Each check cycle, a human checker creates a `Data_checks` row recording the institution's
`chtr_index_url`; the pipeline scrapes that URL *unconditionally*, regardless of any human
judgment field, since gating the scrape itself on a human field was an earlier design mistake that
silently missed late-posted or quietly-revised reports. Every URL the scrape discovers is checked
against `Ledger` (one row per distinct URL, deduplicated by a boilerplate-stripped content hash):
an unchanged URL just updates `last_seen_date`; a new or changed URL gets an `Artifacts` row (the
actual captured content, stored in R2) and is routed to AI extraction. `Pipeline-runs` records each
batch run (prompt version, status, timing) that `Artifacts`/`Data_checks` link back to.

**Staging (schema: staging).** AI extraction reads an `Artifacts` row and proposes a
`Staging_incidents` row (raw + normalized incident fields, an `extraction_confidence` score, and a
`human_review_status` gate) and, where an organization is named, a `Staging_organizations` row
(reviewed and promoted *independently* of its incident — either side can be approved first).
Before/alongside staging a new incident, the pipeline checks two lookup keys against already-public
`Incidents` rows; a hit writes a `Staging_incident_possible_matches` row recording whether this
looks like a duplicate re-extraction or an actual status update to an existing incident
(`match_basis`) — this determines whether promotion later inserts a new row or updates one in
place. Anything needing reviewer attention (a missing required field, ambiguous alcohol/drug
wording, low model confidence, an unclassifiable organization type, etc.) is surfaced as an
append-only `Staging_incident_review_flags` row — the AI reports flags via a structured `flags`
array in its output JSON, and pipeline code is what actually performs the insert; flags are never
deleted, only stamped `resolved_at` once a post-correction recheck confirms the condition cleared.
Every individual field a reviewer corrects is separately logged to
`Staging_incident_corrections` (one row per changed field, not per save action) — the raw material
for measuring which fields the AI gets wrong most often.

**Promotion to public (schema: public).** Once a `Staging_incidents` row is `Approved`, it's
promoted to `Incidents` — a fresh insert if `match_basis` found nothing or only a duplicate, or an
in-place update of the existing `Incidents` row plus a new `Incident_status_history` entry if
`match_basis` was "Status update to existing incident". `Incidents.staging_incident_id` is frozen
at the *original* promotion and is never repointed by a later status update — the resolving
extraction for each subsequent change is tracked separately via
`Incident_status_history.staging_incident_id`, which is why `Incidents` has no direct `artifact_id`
of its own: a single scalar FK couldn't be correct once an incident has one creating artifact and
potentially several later resolving artifacts. `Incident_dates` (dates) and `Incident_organizations`
(the organization link) both carry a `staging_incident_id` set at staging time and an `incident_id`
that only populates once promotion happens, so the same row serves both the staging and public
phases of an incident's life without a duplicate table. `Organizations` is the canonical org
registry, populated only once a `Staging_organizations` proposal is approved.


## Schema: `public`


### Institution

The fixed roster of ~1,484 postsecondary institutions being tracked, keyed by IPEDS `unitid`.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `region` | Text | Yes | Pulled from Airtable connection | The geographic region assigned to the institution by IPEDS, based on its reporting state, using IPEDS's standard regional classification. |
| `unitid` | Integer (PK, natural key — assigned by IPEDS, not auto-generated) | No | Pulled from Airtable connection | A unique identification number assigned to postsecondary institutions surveyed through IPEDS. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when this institution record was added to the database. |
| `institution` | Text | No | Pulled from Airtable connection | The name of the institution as it appears in the HazingInfo database. |
| `state_territory` | Text | No | Pulled from Airtable connection | The U.S. state or territory in which the institution's campus is located according to the HazingInfo database. |


#### `Institution.region`

*Not AI-extracted*

- **Scope note:** Values are limited to IPEDS's defined region categories (a controlled vocabulary), not a general or colloquial description of geography. 

#### `Institution.unitid`

*Not AI-extracted*

- **Scope note:** All institutions in this database are sourced from the HazingInfo database, so UnitID is expected to be present for every institution record. 

#### `Institution.created_at`

*Not AI-extracted*

- **Scope note:** Marks when this institution started being tracked in our database — from the initial IPEDS bulk import, or from whenever it was added later if not part of that original load. Answers 'how long have we been tracking this school,' and, combined with the earliest linked Incident's date, lets you compute the gap from first-tracked to first-incident-found without storing that span as its own field — it's derivable via institution_unitid → Incidents → Incident_dates.

#### `Institution.institution`

*Not AI-extracted*


#### `Institution.state_territory`

*Not AI-extracted*


### Pipeline-runs

One row per batch run of the scraping/extraction pipeline. Tracks which prompt version was used and whether the run completed cleanly.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `pipeline_run_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for this pipeline run. |
| `prompt_version` | Text | No | Pipeline-populated | Identifies which version of the AI extraction prompt was used for a given pipeline run. |
| `run_completed_at` | TIMESTAMPTZ | Yes | Pipeline-populated | Timestamp when this batch run finished (successfully or otherwise). |
| `run_status` | Enum (Controlled vocab) | No | Pipeline-populated | Whether this batch run is still in progress, completed cleanly, or hit an error partway through. |
| `run_started_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp when this batch run began. |


#### `Pipeline-runs.pipeline_run_id`

*Not AI-extracted*


#### `Pipeline-runs.prompt_version`

*Not AI-extracted*

- **Scope note:** Exists for reproducibility/auditing — if extraction quality changes or a specific incident record looks off, this field lets you trace it back to exactly which prompt logic produced it.
- **⚠️ Open question:** Confirm with Mahir how prompt versions are actually labeled/incremented (e.g., a version number, a date-stamp, a git commit hash) so the normalization rule can be documented precisely.

#### `Pipeline-runs.run_completed_at`

*Not AI-extracted*

- **Scope note:** Blank while the run is still in progress, or if the run crashed before completing — combined with run_status, this is what distinguishes a still-running batch from one that errored out mid-way.

#### `Pipeline-runs.run_status`

*Not AI-extracted*

- **Scope note:** Batch-level counterpart to Data_checks.pipeline_status, which tracks processing state per institution; this tracks it per run. Deliberately does not store which schools succeeded/failed or how many incidents were found — that's derivable from the Artifacts (and downstream Staging_Incidents) linked to this run via Artifacts.pipeline_run_id, same "don't duplicate a derivable fact" reasoning used throughout this schema.
- **Controlled vocabulary terms:** Running; Complete; Partial-Error

#### `Pipeline-runs.run_started_at`

*Not AI-extracted*


### Data_checks

One row per institution per check cycle. Records the human checker's `chtr_index_url` and tracks whether the pipeline has processed that cycle's check yet.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when this Data Check record was created in the database. |
| `pipeline_status` | Enum (Controlled vocab) | No | Pipeline-populated | Whether the pipeline has processed this Data Check record yet, and whether that processing completed cleanly. |
| `data_check_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the Data_checks table. Auto-generated at insert. |
| `pipeline_run_id` | Integer (FK → Pipeline-runs.pipeline_run_id) | No | Pipeline-populated | Foreign key pointing to the batch pipeline run that processed this Data Check record. |
| `data_check_date` | Date | No | Pulled from Airtable connection | The date on which an institution's data check record was approved/finalized by HazingInfo staff or a volunteer during a data check cycle. |
| `chtr_index_url` | URL | Yes | Pulled from Airtable connection | The URL for the main landing page for the institution's campus hazing transparency reporting. The incident reports may be all stored within this page (such as in accordions on the page), or this page may have links to the individual reports.  |
| `unitid` | Integer (FK → Institution.unitid) | No | Pulled from Airtable connection | A unique identification number assigned to postsecondary institutions surveyed through IPEDS. |
| `checked_by` | Text | No | Pulled from Airtable connection | The person who performed this Data Check record's check. |


#### `Data_checks.created_at`

*Not AI-extracted*

- **Scope note:** Distinct from data_check_date, which is the checker's own calendar date of when they performed the check in Airtable — this field marks when the row actually became a Data_checks record in our database, which can lag behind the check date since checks are batched and synced over rather than ingested instantly. Combined with Pipeline-runs.run_started_at (via pipeline_run_id), this lets you compute how long a check sat before a pipeline run picked it up, without needing a separate field for that gap.

#### `Data_checks.pipeline_status`

*Not AI-extracted*

- **Scope note:** Tracks processing state of data check record. 
- **Controlled vocabulary terms:** Complete; Awaiting processing; Partial/Error

#### `Data_checks.data_check_id`

*Not AI-extracted*


#### `Data_checks.pipeline_run_id`

*Not AI-extracted*

- **Scope note:** Added so a Data_checks row can be traced back to its batch run even when it produces zero Artifacts — the normal, common outcome when the ledger finds nothing new or changed. Relying only on Artifacts.pipeline_run_id would make most schools in a typical run invisible to that run, since most checks are expected to come back unchanged.

RE-POINTABLE, NOT FROZEN : unlike Artifacts.pipeline_run_id (set once at Artifact creation, never changes), this field reflects the most recent run to touch this Data_checks row — it gets updated if a Partial/Error run is later retried. This is intentional: Data_checks is the same row updated in place as the pipeline works through it (not recreated per attempt), so this field answers 'which run most recently processed this check,' not 'which run originally created it.' Do not use this field to attribute an existing Artifact's run — use Artifacts.pipeline_run_id directly for that, since it stays correct even after a retry updates this field.

#### `Data_checks.data_check_date`

*Not AI-extracted*

- **Scope note:** Reflects the "last updated" value from the source Airtable record at the time of upload into the database.
- **⚠️ Open question:** This field is captured in Airtable as DD/MM/YY while our AI-extracted fields use YYYY-MM-DD — how is that inconsistency handled/reconciled in Neon?

#### `Data_checks.chtr_index_url`

*Not AI-extracted*

- **Scope note:** This field always points to the institution's CHTR landing/index page, not to an individual report or document URL. If an institution stores its incident reports directly on the index page (such as in an accordion), this field still records the index page's URL rather than any sub-link. Individual report URLs are not separately collected.

#### `Data_checks.unitid`

*Not AI-extracted*

- **Scope note:** Serves as the join key linking each data check record to its corresponding institution record via UnitID

#### `Data_checks.checked_by`

*Not AI-extracted*

- **Scope note:** Standard audit field that collects which person created the data check record during HazingInfo's data check process.

### Ledger

One row per distinct URL ever discovered. Fingerprints fetched content (after stripping boilerplate/date tokens) so unchanged pages are skipped instead of re-extracted every cycle.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `first_seen_date` | TIMESTAMPTZ | No | Pipeline-populated | The date this exact URL was first encountered by the pipeline. |
| `source_url` | URL | No | Pipeline-populated | The actual URL the pipeline fetched and checked — the specific page the CHTR content lives on, discovered by scraping the institution's CHTR index page. |
| `last_seen_date` | TIMESTAMPTZ | No | Pipeline-populated, overwritten each cycle | The most recent date this URL was encountered by the pipeline, whether or not its content had changed. |
| `fingerprint_content_hash` | Text (hash) | No | Pipeline-populated | A hash of the fetched URL's content, used to detect whether a previously-seen URL has changed since it was last processed. |
| `unitid` | Integer (FK → Institution.unitid) | No | Pipeline-populated | The institution this URL belongs to. |
| `ledger_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the Ledger table. |


#### `Ledger.first_seen_date`

*Not AI-extracted*

- **Scope note:** Set once, at the URL's first appearance in the ledger, and never updated afterward — a fixed point of origin for this URL's history.

#### `Ledger.source_url`

*Not AI-extracted*

- **Scope note:** For institutions where all the content lives directly on the index page, this is the same URL as chtr_index_url. For institutions with separate linked report pages, this is each individual report's URL — one ledger row per distinct URL, not one per institution.

#### `Ledger.last_seen_date`

*Not AI-extracted*

- **Scope note:** Updated on every cycle the URL is re-scraped, regardless of whether the hash matched (unchanged) or not (changed and re-extracted). This is what distinguishes a URL still actively being checked from one that's stopped showing up in scrapes at all — e.g., if an institution takes a page down.
- **⚠️ Open question:** Open question: should we track each individual "checked, unchanged" event, not just the current overwritten last_seen_date? Currently only actual content changes are preserved as history (via new Artifact rows); an unchanged check just bumps this field in place with nothing logged about the prior check-and-confirm events. Tracking every unchanged check too would let us report a "tokens saved by the ledger" stat (how many AI extraction calls were skipped), at the cost of a new write on every URL, every cycle. Decided against building this by default (mirrors the no_chtr_found/resolves_check_id call — current state over full history when nothing specific needs the history) — but worth reconsidering if that tokens-saved stat becomes something we actually want to report (e.g., for a funder or the maintenance guide).

#### `Ledger.fingerprint_content_hash`

*Not AI-extracted*

- **Scope note:** Computed after stripping recognizable date/reporting-period text from the content first — otherwise a URL that only swapped out a date stamp (a common template pattern) would falsely register as "changed" every cycle. Comparing a new hash to this stored value is what tells the pipeline whether to skip extraction (unchanged) or re-run it (changed). This value is overwritten in place on each content change, not versioned — the Ledger only needs to answer "is this the current known state of this URL," not preserve history. The actual version history (what changed, when) is preserved separately, in the sequence of Artifact records linked to this Ledger row via Artifacts.ledger_id — each new Artifact created marks a content change event with its own timestamp, so nothing is lost by the Ledger overwriting.
- **⚠️ Open question:** Confirm the hashing/normalization step is documented somewhere 

#### `Ledger.unitid`

*Not AI-extracted*

- **Scope note:** Foreign key pointing back to the associated institution for reporting purposes only — it is not part of how the ledger looks up whether a URL has been seen before (that's source_url), or whether that URL's content has changed since (that's the fingerprint_content_hash comparison).

#### `Ledger.ledger_id`

*Not AI-extracted*


### Artifacts

One row per captured content snapshot (new or changed) — the actual object stored in R2 that AI extraction runs against. FKs to Ledger/Data_checks/Pipeline-runs are set at creation and never deferred, so even a zero-incident artifact stays traceable.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `ledger_id` | Integer (FK → Ledger.ledger_id) | No | Pipeline-populated | Foreign key pointing to the Ledger record this artifact was created from. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | When this artifact record was created — i.e., when the pipeline captured this piece of scraped content. |
| `pipeline_run_id` | Integer (FK → Pipeline-runs.pipeline_run_id) | No | Pipeline-populated | Foreign key pointing to the batch pipeline run that produced this artifact. |
| `artifact_location` | Text (R2 object key) | No | Pipeline-populated | The Cloudflare R2 object key where this artifact's captured content is stored. |
| `content_hash_snapshot` | Text (hash) | No | Pipeline-populated | A snapshot of the content hash at the moment this artifact was created. |
| `artifact_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the Artifacts table. Auto-generated at insert. |
| `data_check_id` | Integer (FK → Data_checks.data_check_id) | No | Pipeline-populated | Foreign key pointing to the Data Check record this artifact was produced under. |
| `artifact_format` | Enum (Controlled vocab) | No | Pipeline-populated, derived automatically from response headers | The content format of the fetched artifact, determined automatically from the HTTP response. |


#### `Artifacts.ledger_id`

*Not AI-extracted*

- **Scope note:** Use Artifacts.ledger_id → Ledger.source_url to identify source_url when needed.

#### `Artifacts.created_at`

*Not AI-extracted*


#### `Artifacts.pipeline_run_id`

*Not AI-extracted*

- **Scope note:** Added so a specific Artifact (and everything downstream of it — Staging_Incidents via Staging_incidents.artifact_id, and the school via Artifacts.data_check_id) can be traced back to the exact batch run that produced it — the audit/monitoring purpose Pipeline-runs exists for.

FROZEN AT CREATION — not redundant with Data_checks.pipeline_run_id: a Data_checks row can be re-run by a later pipeline run if an earlier run left it Partial/Error (Data_checks.pipeline_run_id gets updated on retry to reflect the most recent run that touched it). This field, by contrast, is set once when the Artifact itself is created and never changes. That means an Artifact actually created during an earlier failed run keeps correctly pointing at that original run, even after its parent Data_checks row has since been updated to point at a later retry. Deriving an Artifact's run via Artifacts → Data_checks → Pipeline-runs would give the wrong (most recent, not original) answer in exactly that retry scenario — this field is what keeps that fact honest.

#### `Artifacts.artifact_location`

*Not AI-extracted*

- **Scope note:** Distinct from source_url (the live page it came from) — this is our own archived copy, addressed by an R2 object key rather than a public URL. Not directly browsable as a link; retrieving the content requires going through R2, not just following this value in a browser.
- **⚠️ Open question:** Confirm exact key structure/naming convention with Mahir?

#### `Artifacts.content_hash_snapshot`

*Not AI-extracted*

- **Scope note:** Fixed at creation, never overwritten — distinct from Ledger.fingerprint_content_hash, which gets overwritten on each subsequent content change, thus this field is needed for audit/archive purposes. This is what lets a specific Artifact record be checked later against exactly the hash it was created from, even after the Ledger has since moved on to a newer hash.

#### `Artifacts.artifact_id`

*Not AI-extracted*


#### `Artifacts.data_check_id`

*Not AI-extracted*

- **Scope note:** Not redundant with the Artifact→Incident→Data_check chain: an Artifact can be created (new/changed content routed to extraction) even when AI extraction ultimately finds zero incidents, which would otherwise leave that Artifact with no path back to its Data Check record — the exact record meant to prove the institution was reached/scraped that cycle.

#### `Artifacts.artifact_format`

*Not AI-extracted*

- **Scope note:** Set from the response's Content-Type header at fetch time — not inferred from the URL or file extension, and not something a human needs to classify. 
- **Controlled vocabulary terms:** HTML; PDF; Other

### Incidents

The public, canonical incident record — populated only once a Staging_incidents row is approved by a human reviewer and promoted.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `drugs_involved` | Enum (Controlled vocab) | No | Promoted from the approved Staging_incidents record. | Whether the violation involved the abuse or illegal use of drugs. |
| `institution_unitid` | Integer (FK → Institution.unitid) | No | Pipeline-populated at incident creation time, copied from the parent Data check record's UnitID. Never entered or edited independently of that source. | IPEDS UnitID of the institution this incident belongs to. A direct foreign key from this Incidents record to the matching Institution record, distinct from the incident's link to its parent Data check. |
| `notice_date` | Date (YYYY-MM-DD) | Yes | Promoted from the approved Staging_incidents record. | The date the institution provided notice to the organization that the incident resulted in a hazing violation. |
| `institutional_recognition_status` | Enum (Controlled vocab) | No | Promoted from the approved Staging_incidents record. | New August 17, 2026. The organization's institutional recognition status *at the time of this specific incident* — per-incident, not per-organization, since the same org can be Recognized for one incident and Formerly Recognized for a later one. |
| `staging_incident_id` | Integer (FK → Staging_Incidents.staging_incident_id) | No | Pipeline-populated at promotion | Foreign key pointing to the Staging_Incidents record this public incident was promoted from. |
| `incident_description_raw` | Text | Yes | Promoted from the approved Staging_incidents record. | A general narrative description of the hazing incident(s) as published by the institution. |
| `incident_id` | Integer (PK, auto-generated) | No | System-generated (database identity/sequence, assigned automatically at insert) | Primary key for the Incidents table. Auto-generated at insert (database identity/sequence)  |
| `investigation_end_date_raw` | Text | Yes | Promoted from the approved Staging_incidents record. | The date the investigation ended/concluded with a finding of responsibility, exactly as written in the source document, before any normalization. |
| `investigation_start_date_raw` | Text | Yes | Promoted from the approved Staging_incidents record. | The date the institution's investigation was initiated, exactly as written in the source document, before any normalization. |
| `notice_date_raw` | Text | Yes | Promoted from the approved Staging_incidents record. | The date the institution provided notice to the organization that the incident resulted in a hazing violation, exactly as written in the source document, before any normalization. |
| `sanctions_raw` | Text | Yes | Promoted from the approved Staging_incidents record. | The sanctions / outcomes the institution imposed on the organization. |
| `investigation_start_date` | Date (YYYY-MM-DD) | Yes | Promoted from the approved Staging_incidents record. | The date the institution's investigation was initiated. |
| `determination_status` | Enum (Controlled vocab) | No | Promoted from the approved Staging_incidents record. | The institution's determination of the incident — whether it was dismissed, is still pending investigation, or was determined to be hazing. |
| `updated_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of the most recent write to this record — either its original promotion from staging, or a later determination_status update logged in Incident_status_history. |
| `findings_raw` | Text | Yes | Promoted from the approved Staging_incidents record. | The institution's finding(s) / rationale — what the organization was found responsible for. |
| `alcohol_involved` | Enum (Controlled vocab) | No | Promoted from the approved Staging_incidents record. | Whether the violation involved the abuse or illegal use of alcohol. |
| `investigation_end_date` | Date (YYYY-MM-DD) | Yes | Promoted from the approved Staging_incidents record. | The date the investigation ended / concluded with a finding of responsibility. |


#### `Incidents.drugs_involved`

*Not AI-extracted*

- **Scope note:** The drug half of the federal alcohol-or-drug data point, modeled as its own field alongside alcohol_involved. Same normalization and source-pattern handling as alcohol_involved. 'Not specified' means drugs were neither stated nor implied in the source — never inferred as 'No' from silence.
- **Normalization rule:** Map to the controlled vocabulary (Yes / No / Not specified). Populate independently of alcohol_involved.
- **Controlled vocabulary terms:** Yes; No; Not specified; Unable to determine - Unclear reporting

#### `Incidents.institution_unitid`

*Not AI-extracted*


#### `Incidents.notice_date`

*Not AI-extracted*

- **Scope note:** When the organization was formally notified of the finding/outcome. Distinct from the date the finding was made (investigation_end_date), though some institutions report them together.
- **Normalization rule:** Normalize to YYYY-MM-DD.

#### `Incidents.institutional_recognition_status`

*Not AI-extracted*

- **Scope note:** New August 17, 2026. Deliberately per-incident, not per-organization — the same organization can be Recognized for one incident and Formerly Recognized - Lost Recognition for a later one (e.g. after losing its charter as a consequence of an earlier incident). Do not code Formerly Recognized if recognition was revoked as a *consequence* of the incident being coded — at the moment that incident occurred, the organization was still Recognized; only a later incident (after the loss took effect) would be Formerly Recognized. Retires the old organization_type value "Unrecognized Organization" — recognition status is now tracked independently here rather than conflated with organizational category.
- **Normalization rule:** Defaults to "Recognized" when the source doesn't address recognition at all — CHTR-reported organizations are presumed institutionally recognized absent explicit evidence otherwise. No flag is written for this default.
- **Controlled vocabulary terms:** Recognized; Unrecognized-Underground; Formerly Recognized - Lost Recognition; Unknown-Not Stated

#### `Incidents.staging_incident_id`

*Not AI-extracted*

- **Scope note:** Added so every promoted Incident has a guaranteed, direct path back to Staging_Incidents — and from there, via Staging_incidents.artifact_id → Artifacts.data_check_id, back to the Data_checks record it originated from. Before this field, that traceability only worked incidentally, by piggybacking on Incident_dates.staging_incident_id or Incident_Organizations.staging_incident_id when either happened to be linked — not guaranteed if an incident had no linked date or organization row.  Data Check record → Artifact → Staging_Incident → (once approved) Incident' as a fully traceable chain.

FROZEN AT ORIGINAL PROMOTION: when a Pending incident is later updated to a resolved determination_status, this field is NOT overwritten to point at the resolving/rescanned Staging_Incidents row. It continues to point at the original extraction that first created this incident. This field answers 'how did this row come to exist,' not 'what most recently touched it' — same frozen-provenance treatment as Artifacts.content_hash_snapshot. The resolving extraction is tracked separately: see Incident_status_history.staging_incident_id.

WHY THERE'S NO artifact_id DIRECTLY ON Incidents: this is intentional, not an oversight — go through this field to Staging_Incidents.artifact_id instead. A single artifact_id on Incidents couldn't be correct once status updates exist: an incident can have one original creating artifact and a separate resolving artifact per later status change, so a single scalar field would have to pick one and be wrong about the rest. The full artifact history is already fully reconstructable without a new field: original artifact via Incidents.staging_incident_id → Staging_Incidents.artifact_id; each resolving artifact via Incident_status_history.staging_incident_id → Staging_Incidents.artifact_id (one row per status change).

#### `Incidents.incident_description_raw`

*Not AI-extracted*

- **Scope note:** Verbatim narrative. May itself contain the dates, alcohol/drug involvement, or findings — extract those into their own fields too, but keep this text intact and complete. Genuinely null when the source has no narrative description (added August 17, 2026) — displayed to the public as an explicit "No description provided" message rather than any AI-authored placeholder text, since this field is shown directly to end users.
- **Normalization rule:** Preserve full text including paragraph breaks. Do not summarize or truncate.
- **Missing value handling:** Leave null and write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' if the source has no narrative description at all.

#### `Incidents.incident_id`

*Not AI-extracted*


#### `Incidents.investigation_end_date_raw`

*Not AI-extracted*

- **Scope note:** Preserved verbatim as a fallback/audit trail and to surface exactly what the institution stated to the public. Genuinely null (not a "Not Specified" placeholder string) when absent — corrected August 17, 2026, see the header note; a field named "_raw" promises verbatim source text, and a placeholder string is indistinguishable from real source text.

#### `Incidents.investigation_start_date_raw`

*Not AI-extracted*

- **Scope note:** Preserved verbatim as a fallback/audit trail and to surface exactly what the institution stated to the public. Genuinely null (not a "Not Specified" placeholder string) when absent — corrected August 17, 2026, see the header note.

#### `Incidents.notice_date_raw`

*Not AI-extracted*

- **Scope note:** Preserved verbatim as a fallback/audit trail and to surface exactly what the institution stated to the public. Genuinely null (not a "Not Specified" placeholder string) when absent — corrected August 17, 2026, see the header note.

#### `Incidents.sanctions_raw`

*Not AI-extracted*

- **Scope note:** The consequences (probation, suspension, education, etc.) and any timelines. Distinct from findings — this is what happens to them as a result. Genuinely null when no sanctions are stated (added August 17, 2026).
- **Normalization rule:** Preserve verbatim including any list structure and dates/timelines within.
- **Missing value handling:** Leave null if no sanctions are stated. Flag conditionally, not always — write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' only when determination_status is 'Determined hazing'. The Act requires sanctions only "as applicable"; a Dismissed or Not specified determination legitimately has none to report, and flagging those the same as a genuine gap would bury real compliance issues (a Determined hazing incident with no recorded sanction) in noise.

#### `Incidents.investigation_start_date`

*Not AI-extracted*

- **Scope note:** The start of the investigation, distinct from the date it was reported and the date it concluded.
- **Normalization rule:** Normalize to YYYY-MM-DD. If a single 'Dates of Investigation: A - B' range is given, A = this field, B = investigation_end_date.

#### `Incidents.determination_status`

*Not AI-extracted*

- **Scope note:** A content field describing what happened in the real world, distinct from Staging_incidents.human_review_status (whether a human reviewer has signed off on the record as accurate for the public table) and from reviewed_by/reviewed_date (audit — who did that sign-off and when). Can be updated after initial promotion when a rescan resolves a previously Pending incident — see Incident_status_history, which logs each such change, and updated_at, which reflects the most recent one. Any such update is human-reviewed first (via the normal Staging_incidents.human_review_status gate on the rescanned candidate), never applied automatically.
- **Controlled vocabulary terms:** Dismissed; Pending; Determined hazing; Not specified

#### `Incidents.updated_at`

*Not AI-extracted*

- **Scope note:** Added alongside Incident_status_history so a reader can tell this record was touched after its original promotion, rather than silently looking like it was always in its current state. Distinct from Staging_Incidents.reviewed_date, which records the original promotion sign-off, not any later update.

#### `Incidents.findings_raw`

*Not AI-extracted*

- **Scope note:** The adjudicated outcome (policies violated, finding categories). Distinct from sanctions (the consequences) and from the incident description (the alleged conduct). Had no dedicated extraction rule at all before August 17, 2026 — added this pass.
- **Normalization rule:** Preserve verbatim.
- **Extraction disambiguation rule:** Resolve in order: (1) a labeled findings/"found responsible"/"policy violated" field; (2) the determination of responsibility within the incident description; (3) the sanctions/outcome text. 
- **Missing value handling:** Leave null and write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' if none of the three resolution steps find a finding — the Act requires the institution's findings as part of the violation description.

#### `Incidents.alcohol_involved`

*Not AI-extracted*

- **Scope note:** One half of the federal alcohol-or-drug data point, modeled as its own field alongside drug_involved. A normalized Yes/No/Not specified judgement, distinct from the narrative even when only implied in prose. 'Not specified' means alcohol was neither stated nor implied in the source — never inferred as 'No' from silence.
- **Normalization rule:** Map to the controlled vocabulary (Yes / No / Not specified). Populate independently of drug_involved.
- **Controlled vocabulary terms:** Yes; No; Not specified; Unable to determine - Unclear reporting

#### `Incidents.investigation_end_date`

*Not AI-extracted*

- **Scope note:** The conclusion-with-finding date. Many institutions conflate this with the 'resolution' date — treat 'concluded with a finding' and 'resolution/responsible finding' as this field unless the source clearly separates resolution as a later step.
- **Normalization rule:** Normalize to YYYY-MM-DD. Take the END of a combined investigation date range.

### Incident_organizations

Link table connecting a promoted incident to its promoted organization(s), mirroring the same link already made in staging between Staging_incidents and Staging_organizations.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `staging_incident_id` | Integer (FK → Staging_Incidents.staging_incident_id) | No | Pipeline-populated | Foreign key pointing to the staging incident record this organization link belongs to. |
| `organization_id` | Integer (FK → Organizations.organization_id) | Yes | Pipeline-populated | Foreign key pointing to the public Organizations record this incident is linked to, once that Organization record has been approved and promoted. |
| `incident_organization_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for this incident-to-organization link record. |
| `incident_id` | Integer (FK → Incidents.incident_id) | Yes | Pipeline-populated | Foreign key pointing to the public Incidents record this organization link belongs to, once the parent incident has been approved and promoted. |
| `staging_organization_id` | Integer (FK → Staging_Organizations.staging_organization_id) | No | Pipeline-populated | Foreign key pointing to the proposed Organization record (in Staging_Organizations) this incident is linked to. |


#### `Incident_organizations.staging_incident_id`

*Not AI-extracted*

- **Scope note:** Always set at creation, same pattern as Incident_dates.staging_incident_id — an incident's organization is proposed at extraction time, before the incident is ever promoted. Never changes once set.

#### `Incident_organizations.organization_id`

*Not AI-extracted*

- **Scope note:** Blank until the linked Organization record's own human_review_status moves to Approved — independent of whether the parent incident itself has been promoted yet, since an incident and its organization can be approved in either order.

#### `Incident_organizations.incident_organization_id`

*Not AI-extracted*


#### `Incident_organizations.incident_id`

*Not AI-extracted*

- **Scope note:** Blank while the parent incident is still in staging; populated at promotion time, same pattern as Incident_dates.incident_id.

#### `Incident_organizations.staging_organization_id`

*Not AI-extracted*

- **Scope note:** Always set at creation — an organization is proposed and linked at the same extraction moment as the incident itself, regardless of whether that Organization record has been separately reviewed yet.

### Incident_dates

Incident start/end date instances (raw + normalized + precision + granularity), split into its
own table so the same row can serve both the staging and public phases of an incident's life
without duplication.

**Redesigned August 17, 2026: one incident can now have multiple rows.** A hazing pattern can
recur on genuinely separate, non-consecutive occasions (e.g. "Fall 2022, Fall 2023, and Fall
2024") — one start/end pair can't represent that without either inventing a false continuous span
or losing information. `incident_id`/`staging_incident_id` already carried no uniqueness
constraint forcing one row per incident, so no structural change was needed to support this;
what changed is that multiple rows per incident is now the expected design, not an edge case.
Segmentation guidance (implemented in `prompt.md`, not enforced at the database level): a single
date/range is one row; recurrence explicitly framed as happening within one stated period with no
separately-dated occurrences (e.g. "hazed weekly throughout the Fall 2025 semester") is also one
row — `end_date_year`/`end_date_month`/`end_date_academic_term` mirror the `start_date_*`
equivalents rather than being flagged missing, since the named period is the boundary the source
actually gave; genuinely separate, non-consecutive occasions get one row per occasion, never
collapsed into a false continuous span; a genuinely open-ended incident with a start but no
closing information anywhere is the only case that still gets a Legally required field missing flag on
the end side.

**Calendar-anchor convention SUPERSEDED August 17, 2026.** The fixed anchor convention this table
used to document (Month → 1st of month; Academic term → fixed month/day per term name; Academic
year → Sept 1 of first year; Year → Jan 1) did not hold up under real extraction testing — it
assumes a uniform academic calendar across institutions that doesn't exist (semester vs. quarter
vs. trimester), and an anchored date looked authoritative even when it was a guess. `start_date_
normalized`/`end_date_normalized` now populate **only at Day precision**. Six new columns
(below) carry whatever partial granularity the source actually supports at every other precision
level, without fabricating a full date.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `incident_id` | Integer (FK → Incidents.incident_id) | Yes | Pipeline-populated | Foreign key pointing to the public Incidents record this date instance belongs to, once the parent incident has been approved and promoted. |
| `staging_incident_id` | Integer (FK → Staging_Incidents.staging_incident_id) | No | Pipeline-populated | Foreign key pointing to the staging incident record this date instance belongs to. |
| `start_date_normalized` | Date (YYYY-MM-DD) | Yes | AI-extracted from the scraped artifact | The occurrence's start date converted to a standard date value. Populated only at Day precision (corrected August 17, 2026 — see above). |
| `incident_date_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the Incident_dates records. |
| `end_date_raw` | Text | Yes | AI-extracted from the scraped artifact | The occurrence's end date exactly as written in the source document, before any normalization. Genuinely null when absent (corrected August 17, 2026 — no longer a "Not Specified" sentinel string). |
| `start_date_precision` | Enum (Controlled vocab) | No | AI-extracted from the scraped artifact | The granularity of the date captured in start_date_normalized/start_date_year/start_date_month/start_date_academic_term. |
| `end_date_normalized` | Date (YYYY-MM-DD) | Yes | AI-extracted from the scraped artifact | The occurrence's end date converted to a standard date value. Populated only at Day precision. |
| `end_date_precision` | Enum (Controlled vocab) | No | AI-extracted from the scraped artifact | The granularity of the date captured for the occurrence's end date. |
| `start_date_raw` | Text | Yes | AI-extracted from the scraped artifact | The occurrence's start date exactly as written in the source document, before any normalization. Genuinely null when absent (corrected August 17, 2026). |
| `start_date_year` | Integer | Yes | AI-extracted from the scraped artifact | New August 17, 2026. The occurrence's start-date calendar year, populated whenever any year is determinable regardless of precision (Day down through Year). For an academic-year span (e.g. "2024-2025"), uses the first year stated. |
| `start_date_month` | Integer (1-12) | Yes | AI-extracted from the scraped artifact | New August 17, 2026. The occurrence's start-date month, populated only at Day or Month precision — never inferred from a term name. |
| `start_date_academic_term` | Enum (Controlled vocab: Fall/Spring/Summer/Winter) | Yes | AI-extracted from the scraped artifact | New August 17, 2026. Populated only at Academic term precision and only when the source names one of the four recognized terms (or "Autumn," mapped to "Fall"). |
| `end_date_year` | Integer | Yes | AI-extracted from the scraped artifact | New August 17, 2026. Mirrors start_date_year for the occurrence's end date. |
| `end_date_month` | Integer (1-12) | Yes | AI-extracted from the scraped artifact | New August 17, 2026. Mirrors start_date_month for the occurrence's end date. |
| `end_date_academic_term` | Enum (Controlled vocab: Fall/Spring/Summer/Winter) | Yes | AI-extracted from the scraped artifact | New August 17, 2026. Mirrors start_date_academic_term for the occurrence's end date. |


#### `Incident_dates.incident_id`

*Not AI-extracted*

- **Scope note:** Blank while the parent incident is still in staging; populated at promotion time once the parent's human_review_status moves to Approved. Distinct from staging_incident_id, which is always set and never changes — this field is what lets the same date row serve both the staging and public phases of an incident's life without a duplicate table.

#### `Incident_dates.staging_incident_id`

*Not AI-extracted*

- **Scope note:** Always set at creation — every Incident_dates row originates from a staged incident, before that incident is ever promoted to the public Incidents table. This link never changes once set, so traceability back to the original staging record is preserved even after promotion. As of August 17, 2026 this is no longer necessarily one row per incident — see the table-level note above on multiplicity.

#### `Incident_dates.start_date_normalized`

*Inferred*

- **Scope note:** Paired with start_date_precision. Populated **only at Day precision** (corrected August 17, 2026 — see table-level note); at every other precision this field stays null, and start_date_year/start_date_month/start_date_academic_term carry whatever partial granularity the source actually supports instead.
- **Normalization rule:** Normalize to YYYY-MM-DD only when start_date_precision is Day. For every other precision, leave null — do not anchor to any fabricated date (the calendar-anchor convention this rule used to describe is superseded, see table-level note).
- **Extraction disambiguation rule:** Normalize start_date_raw to YYYY-MM-DD only at Day precision. For coarser precision, leave null and rely on start_date_year/start_date_month/start_date_academic_term instead — do not fabricate a specific day where the source only supports month/term/year precision.

#### `Incident_dates.incident_date_id`

*Not AI-extracted*


#### `Incident_dates.end_date_raw`

*Verbatim*

- **Scope note:** Preserved verbatim as a fallback/audit trail — lets a human check the original wording if the normalized date or precision value is ever in question. Genuinely null when absent (corrected August 17, 2026), never a "Not specified" placeholder string.
- **Normalization rule:** Capture exactly as written, trim whitespace
- **Extraction disambiguation rule:** The later date of a reported range (see start_date_raw). For a single-day occurrence with no separate end date given, mirror every start_date_* field's actual value here (see Missing value handling) — this is copying real values, not inventing a sentinel, so no flag is needed. For recurrence contained within one stated period (see table-level note), mirror start_date_year/month/academic_term rather than leaving null. Capture verbatim, including partial dates.
- **Missing value handling:** For single-day occurrences (start_date_precision = Day) with no separate end date reported, mirror every start_date_* field's actual value (raw, normalized, precision, year, month, academic_term) into the matching end_date_* field. For recurrence contained within one stated period at any other precision, mirror start_date_year/month/academic_term (the named period is its own end) rather than flagging missing. Only for a genuinely open-ended occurrence with no closing information anywhere does this leave null — and it writes NO flag (changed August 17, 2026; this case previously wrote 'Required field missing'). An incident end date is not an element the Stop Campus Hazing Act requires an institution to publish: the Act names only the date on which the incident was alleged to have occurred. Flagging an unstated end date as a legally required field would report a fully compliant institution as non-compliant, and CHTRs rarely state an end date at all, so the flag would fire constantly against schools that have done nothing wrong. It is not an 'Unable to derive value' case either — nothing failed to derive; there is simply no end date to record.

#### `Incident_dates.start_date_precision`

*Inferred*

- **Scope note:** Exists because institutions report incident dates with wildly inconsistent specificity; this field lets each occurrence be populated at whatever precision the source actually supports without fabricating false precision. Distinguish Academic Term (a specific semester/quarter, e.g. 'Fall 2025') from Academic Year (a full academic-year span, e.g. '2024–2025'); do not collapse one into the other. Mirrors the same precision logic as end_date_precision.
- **Normalization rule:** Set based on the actual specificity stated in the source — never infer a finer precision than what's written (e.g., don't default an unstated day to the 1st of the month).
- **Extraction disambiguation rule:** Determine precision from how specific the raw date text actually is — never infer finer precision than what's stated:
- Full calendar date given (e.g., "9/20/2025," "September 20, 2025") → Day
- Month and year given, no day (e.g., "September 2025") → Month
- A specific academic term given (e.g., "Fall 2025," "Spring 2024," or "Autumn 2025" — "Autumn" maps to the Fall CV term, added August 17, 2026) → Academic term
- A full academic-year span given (e.g., "2024–2025 academic year") → Academic year. Qualifier phrases like "sometime during" or "at some point in" do not change the precision level.
- Only a calendar year given, no term/month/day (e.g., "2024") → Year
- Vague qualifiers on a finer unit (e.g., "early March 2024," "late Fall 2025") → use the more specific unit named — the qualifier itself doesn't add or remove precision.
- **Missing value handling:** If start_date_raw came back null (no date stated anywhere in the source), output 'Unknown' here — no separate flag needed, since start_date_raw's own missing-value rule already writes a Staging_Incident_Review_Flags entry for this same underlying gap.
- **Controlled vocabulary terms:** Day; Month; Academic term; Academic year; Year; Unknown
- **Example output value:** Academic term

#### `Incident_dates.end_date_normalized`

*Inferred*

- **Scope note:** Paired with end_date_precision. Populated **only at Day precision** (corrected August 17, 2026), same as start_date_normalized.
- **Normalization rule:** Normalize to YYYY-MM-DD only when end_date_precision is Day. For every other precision, leave null — following the same corrected rule as start_date_normalized.
- **Extraction disambiguation rule:** Normalize end_date_raw to YYYY-MM-DD only at Day precision, following the same rule as start_date_normalized. For single-day occurrences, see Missing value handling on end_date_raw for the mirroring rule.
- **Missing value handling:** For single-day occurrences, set equal to start_date_normalized. Otherwise null unless Day precision.

#### `Incident_dates.end_date_precision`

*Inferred*

- **Scope note:** Exists for the same reason as start_date_precision. Uses the same six-value vocabulary (Day / Month / Academic term / Academic year / Year / Unknown).
- **Normalization rule:** Set based on the actual specificity stated in the source — never infer a finer precision than what's written.
- **Extraction disambiguation rule:** Same rule as start_date_precision. For single-day occurrences with no separate end date reported, see Missing value handling on end_date_raw.
- **Missing value handling:** For single-day occurrences with no separate end date reported, set equal to start_date_precision (part of the full six-field mirror — see end_date_raw). Otherwise, if end_date_raw came back null for a genuinely unresolved end, output 'Unknown' here — no separate flag needed.
- **Controlled vocabulary terms:** Day; Month; Academic term; Academic year; Year; Unknown
- **Example output value:** Academic term

#### `Incident_dates.start_date_raw`

*Verbatim*

- **Scope note:** Preserved verbatim as a fallback/audit trail — lets a human check the original wording if the normalized date or precision value is ever in question. Genuinely null when absent (corrected August 17, 2026), never a "Not specified" placeholder string.
- **Normalization rule:** Capture exactly as written, trim whitespace
- **Extraction disambiguation rule:** Look for labels like 'Date of Incident,' 'Incident Date(s),' or a date/date-range embedded in the incident's own heading. If a range is given ('March 3-5, 2024'), this is the earlier/start date — the later date goes to end_date_raw. Capture the date text exactly as written, including partial dates ('Fall 2024', 'early March'). If the incident description contains the only date mention, extract it from there rather than leaving blank.
- **Missing value handling:** Leave genuinely null if no start date is stated anywhere in the source, and write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' — an occurrence with no date at all is a significant gap that needs human review.
- **Example output value:** 9/20/2025; Fall 2025; September 2025

#### `Incident_dates.start_date_year`

*Inferred*

- **Scope note:** New August 17, 2026. Carries the calendar year whenever determinable, independent of precision — this is what makes it possible to sort/filter by year even when the date isn't precise enough for start_date_normalized to populate.
- **Normalization rule:** Integer calendar year. For an academic-year span (e.g. "2024-2025"), use the first year stated.
- **Missing value handling:** Null only when start_date_raw is itself null.

#### `Incident_dates.start_date_month`

*Inferred*

- **Scope note:** New August 17, 2026. Never guessed from a term name (e.g. never infer September for "Fall") — populated only when the source states an actual month.
- **Normalization rule:** Integer 1-12.
- **Missing value handling:** Null at Academic term, Academic year, Year, or Unknown precision. Populated only at Day or Month precision.

#### `Incident_dates.start_date_academic_term`

*Inferred*

- **Scope note:** New August 17, 2026. Populated only at Academic term precision, and only when the source names one of the four recognized terms (including "Autumn" as a recognized synonym for "Fall").
- **Normalization rule:** Store the CV term ("Fall", "Spring", "Summer", or "Winter") — never the source's literal wording if it used a synonym like "Autumn."
- **Missing value handling:** Null at every precision other than Academic term. A term name outside Fall/Spring/Summer/Winter/Autumn also stays null here (the 'Unrecognized date term' flag on start_date_precision already covers that gap) — don't guess the closest match.
- **Controlled vocabulary terms:** Fall; Spring; Summer; Winter

#### `Incident_dates.end_date_year`

*Inferred*

- **Scope note:** New August 17, 2026. Mirrors start_date_year for the occurrence's end date; see that field and the single-day/contained-recurrence mirroring rules on end_date_raw.

#### `Incident_dates.end_date_month`

*Inferred*

- **Scope note:** New August 17, 2026. Mirrors start_date_month for the occurrence's end date.

#### `Incident_dates.end_date_academic_term`

*Inferred*

- **Scope note:** New August 17, 2026. Mirrors start_date_academic_term for the occurrence's end date.
- **Controlled vocabulary terms:** Fall; Spring; Summer; Winter

### Incident_status_history

Append-only log of determination_status changes to an already-public Incidents row (e.g. Pending -> Determined hazing on a later rescan, or a correction on appeal).


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `old_status` | Enum (Controlled vocab) | No | Pipeline-populated | The determination_status value on the Incidents record immediately before this change. |
| `changed_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp when this status change was written. |
| `incident_id` | Integer (FK → Incidents.incident_id) | No | Pipeline-populated | Foreign key pointing to the Incidents record whose determination_status changed. |
| `staging_incident_id` | Integer (FK → Staging_Incidents.staging_incident_id) | No | Pipeline-populated | Foreign key pointing to the Staging_Incidents record whose approval triggered this status change. |
| `new_status` | Enum (Controlled vocab) | No | Pipeline-populated | The determination_status value the Incidents record was updated to. |
| `incident_status_history_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for this status-change record. |


#### `Incident_status_history.old_status`

*Not AI-extracted*

- **Scope note:** This field is populated entirely by pipeline logic at the moment Incidents.determination_status changes — it copies the prior value directly rather than being independently AI-extracted or judged, so it has no Extraction disambiguation rule of its own by design. Uses the same controlled vocabulary as Incidents.determination_status (Dismissed / Pending / Determined hazing / Not specified), captured at the moment of change so the prior value is preserved even after the Incidents row itself is overwritten.
- **Controlled vocabulary terms:** Dismissed; Pending; Determined hazing; Not specified

#### `Incident_status_history.changed_at`

*Not AI-extracted*


#### `Incident_status_history.incident_id`

*Not AI-extracted*

- **Scope note:** The public schema Incident record this status change happened to. This table only ever logs changes to already-promoted, public incidents — a status change during staging review isn't a "change" in this sense, it's just the reviewer setting the value for the first time. Populated only at promotion time, after a human reviewer has approved the candidate Staging_Incidents record that triggered the update (see Staging_incident_possible_matches.match_basis = "Status update to Pending incident").

#### `Incident_status_history.staging_incident_id`

*Not AI-extracted*

- **Scope note:** The specific rescanned/resolving extraction that caused this status change — distinct from Incidents.staging_incident_id, which stays frozen at the incident's original promotion and never updates to reflect a later rescan. Without this field, finding which extraction resolved a given status change would require an indirect join through Staging_incident_possible_matches (existing_incident_id + match_basis = 'Status update to Pending incident'), which this field makes direct instead.

#### `Incident_status_history.new_status`

*Not AI-extracted*

- **Scope note:** This field is populated entirely by pipeline logic at the moment Incidents.determination_status changes — it copies the new value directly rather than being independently AI-extracted or judged, so it has no Extraction disambiguation rule of its own by design. Same vocabulary as old_status. Should always match Incidents.determination_status as of changed_at — if it doesn't, that's a pipeline bug in how this table is being written.
- **Controlled vocabulary terms:** Dismissed; Pending; Determined hazing; Not specified

#### `Incident_status_history.incident_status_history_id`

*Not AI-extracted*


### Organizations

The public, canonical organization registry — populated only once a Staging_organizations proposal is approved.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `organization_type` | Enum (Controlled vocab) | No | AI-inferred from organization name or an oversight-office cue, then human-set during the review of proposed new Organization records | The category of student organization. |
| `membership_gender_composition` | Enum (Controlled vocab) | No | AI-inferred at extraction time, then human-confirmed/corrected during review | New August 17, 2026. The organization's self-identified gender-identity category for membership eligibility — not individual members' sex assigned at birth. |
| `organization_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the Organizations table. Auto-generated at insert. |
| `organization_name` | Text | No | Either manually entered by HazingInfo staff (e.g., Greek life organizations manually entered into database), or created from an approved Staging_Organizations proposal once a reviewer confirms it during incident review. | The standardized/canonical name of the student organization. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated (promotion) or human-entered (manual add) | Timestamp of when this organization record was added to the database, whether by promotion or manual entry. |


#### `Organizations.organization_type`

*Not AI-extracted*

- **Scope note:** Normalized classification to support filtering/analysis. Often not labeled in the incident report itself, but derived from context or from a human reviewer checking and labeling the organization.
- **Normalization rule:** Map to the controlled vocab.
- **Controlled vocabulary terms (replaced August 17, 2026 — see below):** Social fraternity or sorority; Service or professional fraternity or sorority; Varsity athletic team; Club sport; Intramural or recreation sports team; Honor society; Academic club; Performing arts organization; Marching band; ROTC or other military organization; Social club; Faith-based organization; Culturally-based / identity-based organization; Student government or other student leadership organization; Community service organization; Political organization or social action group; Campus media organization; Other type of organization

#### `Organizations.membership_gender_composition`

*Not AI-extracted*

- **Scope note:** New August 17, 2026. Reflects the organization's own self-identified gender-identity category for membership eligibility, not individual members' sex assigned at birth — a single-gender organization that includes transgender members consistent with its stated identity remains single-gender, not Mixed-Co-ed. Do not infer from organization name alone: many organizations using "fraternity" in their name are explicitly co-ed (e.g. professional/business fraternities routinely admit members of any gender) — but "sorority" is a much stronger single-gender signal, since a historically women's organization that opens to men typically disaffiliates and rebrands away from "sorority" entirely rather than keeping the label while admitting men. Replaces the gender-coding that used to be implicit in organization_type's old separate Fraternity/Sorority terms — organization_type now tracks purpose, this field tracks gender composition, independently.
- **Normalization rule:** Defaults to "Unknown-Not stated" when the source doesn't clearly indicate composition; no flag is written for this default, since it's expected to be the common case given how rarely CHTR text states this explicitly.
- **Controlled vocabulary terms:** All-male; All-female; Mixed-Co-ed; Unknown-Not stated

#### `Organizations.organization_id`

*Not AI-extracted*


#### `Organizations.organization_name`

*Not AI-extracted*

- **Scope note:** A cleared, canonical organization record — either entered manually by HazingInfo staff or promoted from an approved Staging_Organizations proposal. By the time a record exists here, it's already been vetted; this table doesn't carry the matching/review logic that got it here.
- **Normalization rule:** Preserve official capitalization. Store as the top-level organization name only — exclude chapter designators (e.g., "Beta Chapter", chapter numbers/letters), legal-entity suffixes ("Inc.", "Incorporated", "LLC"), redundant type words ("Fraternity", "Sorority") unless the word is actually part of the org's official name, and (added August 17, 2026) incident-sequence/report-disambiguation markers the institution appends to distinguish multiple incidents against the same organization within one CHTR (e.g. "(1st)", "(2nd)") — these identify which incident it is, not which organization. E.g., store "Alpha Kappa Kappa", not "Alpha Kappa Kappa Fraternity, Inc. — Beta Chapter"; store "Alpha Kappa Psi", not "Alpha Kappa Psi (2nd)". This must match the stripped form Staging_Organizations.organization_name proposes, since that field's candidate name is what gets matched against this one — a mismatch in stripping convention between the two fields would cause real matches to be missed.

#### `Organizations.created_at`

*Not AI-extracted*

- **Scope note:** Unlike Incidents (where the frozen staging_incident_id → Staging_Incidents.reviewed_date gives a reliable single-hop path back to promotion time), Organizations has no such path: it's populated either by manual entry (e.g. a prefilled Greek life roster) or by promotion from an approved Staging_Organizations proposal, and there's no direct FK back to whichever staging record caused it — only the indirect, many-valued Incident_Organizations join, which can't cleanly identify a single originating proposal. This field is needed because the derived path is actually broken for manually-entered records, not just inconvenient.

## Schema: `staging`


### Staging_incidents

AI-extracted candidate incident records, pending human review. Holds both raw (verbatim) and normalized fields, plus the review gate (human_review_status) that controls promotion to Incidents.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `organization_name_raw` | Text | Yes | AI-extracted from the scraped artifact | The organization name as it appears on the source document, captured prior to matching against the Organizations table. |
| `human_review_status` | Enum (Controlled vocab) | No | Defaults to "Pending Review" until a reviewer acts then is set by human reviewer at review time | The human reviewer's sign-off verdict on whether the incident record is accurate and ready for the public table. |
| `reviewer_notes` | Text | Yes |  Human-entered, at review time | Free-text notes a reviewer leaves when reviewing a staged incident record — why it was rejected, what was corrected before approval, or any other context worth preserving. |
| `investigation_start_date_raw` | Text | Yes | AI-extracted from the scraped artifact | The date the institution's investigation was initiated, exactly as written in the source document, before any normalization. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when this incident record was extracted and staged. |
| `investigation_end_date` | Date (YYYY-MM-DD) | Yes | AI-extracted from the scraped artifact | The date the investigation ended / concluded with a finding of responsibility. |
| `alcohol_involved` | Enum (Controlled vocab) | No | AI-extracted from the scraped artifact | Whether the violation involved the abuse or illegal use of alcohol. |
| `notice_date` | Date (YYYY-MM-DD) | Yes | AI-extracted from the scraped artifact | The date the institution provided notice to the organization that the incident resulted in a hazing violation. |
| `institutional_recognition_status` | Enum (Controlled vocab) | No | AI-extracted from the scraped artifact | New August 17, 2026. Per-incident recognition status — see Incidents.institutional_recognition_status. |
| `organization_name_normalized` | Text | Yes | AI-extracted from the scraped artifact, same extraction pass as organization_name_raw | The AI's cleaned/normalized candidate organization name, derived from organization_name_raw during extraction — chapter designators and legal-entity suffixes stripped, proper capitalization preserved. |
| `reviewed_date` | Date (YYYY-MM-DD) | Yes | Pipeline-populated, automatically, at the moment human_review_status changes to Approved or Rejected | The date the reviewer set human_review_status to Approved or Rejected for this incident record. |
| `artifact_id` | Integer (FK → Artifacts.artifact_id) | No | Pipeline-populated at extraction time | Foreign key pointing to the Artifact record this incident was extracted from. |
| `incident_description_raw` | Text | Yes | AI-extracted from the scraped artifact | A general narrative description of the hazing incident(s) as published by the institution. |
| `staging_incident_id` | Integer (PK, auto-generated) | No | System-generated (database identity/sequence, assigned automatically at insert) | Primary key for the Staging_Incidents table. Auto-generated at insert (database identity/sequence). |
| `sanctions_raw` | Text | Yes | AI-extracted from the scraped artifact | The sanctions / outcomes the institution imposed on the organization. |
| `investigation_start_date` | Date (YYYY-MM-DD) | Yes | AI-extracted from the scraped artifact | The date the institution's investigation was initiated. |
| `extraction_confidence` | Decimal (0.0–1.0) | No | AI self-reported at extraction time | The AI model's self-reported confidence in its own extraction of this specific incident, on a 0.0–1.0 scale. |
| `investigation_end_date_raw` | Text | Yes | AI-extracted from the scraped artifact | The date the investigation ended/concluded with a finding of responsibility, exactly as written in the source document, before any normalization. |
| `institution_unitid` | Integer (FK → Institution.unitid) | No | Pipeline-populated at incident creation time, copied from the parent Data check record's UnitID. Never entered or edited independently of that source. | IPEDS UnitID of the institution this incident belongs to. A direct foreign key from this Incidents record to the matching Institution record, distinct from the incident's link to its parent Data check. |
| `determination_status` | Enum (Controlled vocab) | No | AI-extracted from the scraped artifact | The institution's determination of the incident — whether it was dismissed, is still pending investigation, or was determined to be hazing. |
| `notice_date_raw` | Text | Yes | AI-extracted from the scraped artifact | The date the institution provided notice to the organization that the incident resulted in a hazing violation, exactly as written in the source document, before any normalization. |
| `reviewed_by` | Text | Yes | Human-entered | The reviewer who set human_review_status to Approved or Rejected for this incident record. |
| `findings_raw` | Text | Yes | AI-extracted from the scraped artifact | The institution's finding(s) / rationale — what the organization was found responsible for. |
| `drugs_involved` | Enum (Controlled vocab) | No | AI-extracted from the scraped artifact | Whether the violation involved the abuse or illegal use of drugs. |


#### `Staging_incidents.organization_name_raw`

*Verbatim*

- **Scope note:** The organization, not the individuals. Capture the full name as published. This is the raw captured value, not the matched/linked Organization record.
- **Normalization rule:** Trim whitespace; preserve official capitalization. Do NOT standardize across chapters.
- **Extraction disambiguation rule:** Often a section header, accordion label, or PDF/document title rather than a labeled field — treat that heading text as the value. Capture the full official name, including chapter and Greek / '(Inc.)' designations. If an oversight office or council is shown alongside it ('Organization (Oversight Office)'), keep only the organization name here. One record = one organization; if a section lists several, emit a separate record for each. If no organization is identifiable, write a Staging_Incident_Review_Flags row with flag_type = 'Legally required field missing'. Do not include dates, status, or descriptive text.
- **Missing value handling:** Leave genuinely null if no organization is identifiable anywhere in the source, and write a Staging_Incident_Review_Flags row with flag_type = 'Legally required field missing' — the organization's name is the first element the Act requires a CHTR to publish, so its absence is a compliance gap, not an extraction problem. Nullability corrected to Yes (August 17, 2026): this column has always been nullable in schema.json and catalog_schema.sql, and a NOT NULL constraint here would make an institution's failure to name the organization structurally unrecordable. Do NOT output literal 'Not specified' text — this field is verbatim source text by definition; use real null instead.
- **Example label variants seen:** Name of Student Organization; Organization; Greek-Letter Organization
- **Example output value:** Kappa Alpha Psi

#### `Staging_incidents.human_review_status`

*Not AI-extracted*

- **Scope note:** Distinct from determination_status (what happened in the real world — Pending/Dismissed/Determined Hazing) and from Reviewed by/Reviewed date (audit fields — who touched the record and when, not what they decided). This is the actual gate for public-table promotion. 
- **Controlled vocabulary terms:** Pending review; Approved; Rejected

#### `Staging_incidents.reviewer_notes`

*Not AI-extracted*

- **Scope note:** This is what makes the staging audit trail actually actionable for improving AI extraction prompt over time, rather than just a bare Approved/Rejected count with no explanation of why.

#### `Staging_incidents.investigation_start_date_raw`

*Verbatim*

- **Scope note:** Preserved verbatim as an audit trail — lets a human check the original wording if the normalized date is ever in question. Genuinely null when absent, never a "Not Specified" placeholder string — corrected August 17, 2026.
- **Normalization rule:** Capture exactly as written, trim whitespace
- **Extraction disambiguation rule:** Look for labels like 'Investigation Initiated,' 'Date Investigation Began,' or 'Dates of Investigation' (a combined range — see investigation_start_date's merge-case rule for how the range splits). This is when the investigation began, not the incident date or the date the report was first received. Capture verbatim.
- **Missing value handling:** Leave genuinely null (not 'Not Specified' text — corrected August 17, 2026) if no investigation start date is stated anywhere in the source, and write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' — investigation dates are legally required in CHTRs, so absence here is a compliance gap worth reviewer attention.

#### `Staging_incidents.created_at`

*Not AI-extracted*

- **Scope note:** Marks when the AI actually extracted this record — distinct from reviewed_date, which marks when a human reviewed it. The gap between the two is how long this record sat in the review queue.

#### `Staging_incidents.investigation_end_date`

*Inferred*

- **Scope note:** The conclusion-with-finding date. Many institutions conflate this with the 'resolution' date — treat 'concluded with a finding' and 'resolution/responsible finding' as this field unless the source clearly separates resolution as a later step.
- **Normalization rule:** Normalize to YYYY-MM-DD. Take the END of a combined investigation date range.
- **Extraction disambiguation rule:** Highest label variation in the source set. Normalize to YYYY-MM-DD; take the END of a combined investigation range. MERGE case: 'Date of Responsible Finding and Notice to Organization' and 'Resolution Date and Notice to Organization' combine this with notice_date — use the date for both unless two distinct dates are given. Treat 'concluded with a finding', 'responsible finding', and 'resolution date' as this field unless the source clearly separates resolution as a later, distinct step. If absent, leave genuinely null (a Date-typed column can't hold text at all — corrected August 17, 2026); investigation_end_date_raw carries the verbatim/null fallback instead.

#### `Staging_incidents.alcohol_involved`

*Inferred*

- **Scope note:** One half of the federal alcohol-or-drug data point, modeled as its own field alongside drug_involved. A normalized Yes/No/Not specified judgement, distinct from the narrative even when only implied in prose.
- **Normalization rule:** Map to the controlled vocabulary (Yes / No / Not specified). Populate independently of drug_involved.
- **Extraction disambiguation rule:** Populate alcohol_involved and drug_involved independently. Institutions present this three ways: (1) a separate per-substance field — map each directly, no flag needed. (2) one combined 'alcohol and/or drugs' field — a combined affirmative does NOT confirm both substances: first attempt to allocate from any accompanying description/findings/sanctions text, setting only the substance(s) actually named to Yes. Never infer 'No' for the unconfirmed substance from silence alone — if the text names alcohol but never mentions drugs, drugs stays 'Not specified', not 'No'; only set 'No' if the source explicitly rules that substance out. If allocation genuinely fails — the combined field is affirmative but neither it nor the surrounding text names which substance(s) were involved — set BOTH alcohol_involved and drugs_involved to 'Unable to determine - Unclear reporting' together (added August 17, 2026), not 'Yes' and not 'Not specified': defaulting both to 'Yes' fabricates certainty the source doesn't support, and 'Not specified' already means something different (the source never raised alcohol/drugs at all). If the combined field is affirmative (Yes), ALWAYS write a Staging_Incident_Review_Flags row with flag_type = 'Alcohol/drugs review needed' regardless of whether allocation succeeded — a combined 'Yes' is structurally ambiguous even when the AI feels confident in its read. If the combined field is 'No' (neither substance involved), no flag is needed — that answer is unambiguous and applies cleanly to both fields. (3) stated only in the incident description, no labeled field at all — read it from that text; flag only if genuinely unrecoverable. Output 'Not specified' on silence, never 'No' by default. If the source never addresses alcohol/drugs at all across any of these three patterns (genuine plain silence, not a combined field that just doesn't allocate), also write a Staging_Incident_Review_Flags row with flag_type = 'Legally required field missing' (added August 17, 2026) — this is distinct from the combined-affirmative case above, which uses 'Alcohol/drugs review needed' instead.

Bar for setting 'Yes' from narrative text (cases 2 and 3): only set 'Yes' if the source unambiguously indicates alcohol use — e.g., 'found intoxicated,' 'vomiting from drinking,' 'under the influence of alcohol,' a stated blood alcohol level. Do not infer 'Yes' from adjacent context alone (e.g., 'party,' 'social event,' 'tailgate') without an explicit indication of actual use or intoxication — scene-setting language is not evidence of involvement.
- **Missing value handling:** Output 'Not specified' when alcohol is neither stated nor implied; never infer 'No' from silence.
- **Controlled vocabulary terms:** Yes; No; Not specified; Unable to determine - Unclear reporting
- **Example label variants seen:** Did the Violation Involve the Abuse or Illegal Use of Alcohol or Drugs?; Drug/Alcohol Involvement; Was the abuse or illegal use of alcohol or drugs involved?; Alcohol use

#### `Staging_incidents.notice_date`

*Inferred*

- **Scope note:** When the organization was formally notified of the finding/outcome. Distinct from the date the finding was made (investigation_end_date), though some institutions report them together.
- **Normalization rule:** Normalize to YYYY-MM-DD.
- **Extraction disambiguation rule:** Look for a label indicating the org was informed of the outcome/violation/charges/sanctions — not just labels containing the literal word "notice" (generalized August 17, 2026; the prior version only matched literal "notice" wording, which missed real variants like "Notification of Final Decision"). Confirmed real-world label variants: "Date Notice of Violation Provided to Organization," "Date of Outcome Notice," "Date Student Group Notified of Charge(s)," "Date organization notified of hazing violation," "Notice of findings to organization," "Date Notice Provided to Organization Incident Resulted in Hazing Violation," "Date of Responsible Finding and Notice to Organization" (merge case, see below), "Date the organization was notified of the outcome," "Date of the Organization was Notified of the Violation and Sanctions," "Resolution Date and Notice to Organization" (merge case), "Date Outcome Was Provided to Organization," "Date of Notice to Student Organization," "Notification of Final Decision," "Date Organization Notified by UCA," "Date Organization was Given Notice that Hazing Occurred." Resolve in order: (1) a separately-labeled notice field (notice_date_raw) matching the pattern above — normalize that value; (2) the MERGE case: when the source combines notice with the finding/resolution date in one label ('Date of Responsible Finding and Notice to Organization', 'Resolution Date and Notice to Organization'), use that single date for both this field and investigation_end_date, unless two distinct dates are given; (3) check narrative text (incident_description_raw, sanctions_raw, findings_raw) for an explicit statement of when the organization was notified, if not resolved by (1) or (2). Only if none of these three resolve a notice date, leave genuinely null (not 'Not specified' text — corrected August 17, 2026) and write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' — notice date is legally required in CHTRs, so a genuinely unrecoverable notice date is a compliance gap worth reviewer attention. Do not copy the investigation-end date here unless the source explicitly merges them per (2). Many institutions genuinely have no notice-to-organization field at all (e.g. UT Austin, which labels only conduct-process-resolution, investigation-initiated, report-to-institution, and incident-date — no notice field); do not treat a differently-purposed date as a stand-in just because no better candidate exists — "Date of Report to Institution," for example, is the opposite direction (when the initial complaint was received, not when the org was notified of the outcome) and must not be mapped here (negative case confirmed via real extraction, added August 17, 2026).
- **Missing value handling:** Leave genuinely null (corrected August 17, 2026) only after resolution order (1)-(3) above fail to find a notice date anywhere in the source; write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' at that point, since notice date is legally required.

#### `Staging_incidents.institutional_recognition_status`

*Inferred*

- **Scope note:** New August 17, 2026. Mirrors Incidents.institutional_recognition_status — deliberately per-incident, not per-organization.
- **Normalization rule:** Defaults to "Recognized" on silence — no flag for that default.
- **Controlled vocabulary terms:** Recognized; Unrecognized-Underground; Formerly Recognized - Lost Recognition; Unknown-Not Stated
- **Correction path:** Added to the CORRECTABLE_FIELDS whitelist (mirrored across ingest.py, its TypeScript port, and rebuild.py) — corrected the same way as any other scalar Staging_incidents field.

#### `Staging_incidents.organization_name_normalized`

*Inferred*

- **Scope note:** Distinct from organization_name_raw, which deliberately preserves chapter designations and legal-entity suffixes verbatim for audit purposes. This field is the AI's own cleaned candidate, produced in the same extraction pass, and is what Staging_Organizations.organization_name gets populated from — after a final deterministic safety-net normalization pass applied only at match time: lowercase, trim whitespace, strip stray punctuation, applied to both sides for comparison purposes only, and never changes what's actually stored. This guards against small AI inconsistencies across separate extractions of the same real organization (e.g. a stray trailing period, inconsistent spacing) without requiring the AI to be perfectly rigid. See Staging_Organizations.organization_name's Normalization format rule for the full implementation detail.
- **Normalization rule:** Proper capitalization preserved — this is a cleaned name candidate, not a lowercased matching key. The lowercase/whitespace/punctuation normalization used for actual match comparison happens later, downstream, and does not change what's stored here.
- **Extraction disambiguation rule:** Strip before proposing a candidate name: (1) chapter designators (e.g., 'Beta Chapter', 'Alpha Chapter', chapter numbers/letters); (2) legal-entity suffixes ('Inc.', 'Incorporated', 'LLC'); (3) redundant type words already captured by organization_type ('Fraternity', 'Sorority') UNLESS the word is actually part of the organization's official name — applies wherever the type word appears, not only as a bare trailing suffix (e.g. 'Sigma Alpha Omega Christian Sorority' -> 'Sigma Alpha Omega', not just checking the final word; added August 17, 2026 after confirming this case passed through unstripped); (4) incident-sequence/report-disambiguation markers an institution appends to distinguish multiple incidents against the same org within one CHTR — e.g. '(1st)', '(2nd)', '(#1)', '(#2)' (added August 17, 2026, confirmed via UT Austin's 'Alpha Kappa Psi (1st)'/'Alpha Kappa Psi (2nd)' causing a false-negative organization-match miss before this fix). Do not strip the organization's own distinctive name or Greek letters that are part of its actual identity (e.g., keep 'Alpha Kappa Kappa', don't reduce further). Goal: produce the same clean top-level name regardless of which chapter/institution/incident-sequence reported the incident, since unitid already identifies the institution and incident-level identity is tracked elsewhere. Getting this rule wrong either causes false-negative misses (real match not found) or false-positive merges (two distinct orgs collapsed into one) — flag ambiguous cases for human review rather than guessing.
- **Missing value handling:** Leave null and write a Staging_Incident_Review_Flags row with flag_type = 'Unable to derive value' when the strip is genuinely ambiguous — e.g. the modifier+type phrase may itself be the organization's chosen self-identifying name rather than a descriptor — rather than guessing, since a wrong merge or split causes real matching errors downstream. Do NOT use 'Legally required field missing' here: the normalized name is our own derivation, not an element the Act requires an institution to publish, so a null here says our step failed, not that the school omitted something. When organization_name_raw is itself null, that field's own flag already covers the gap and no separate flag is written here. Nullability corrected to Yes (August 17, 2026), matching schema.json and catalog_schema.sql.

#### `Staging_incidents.reviewed_date`

*Not AI-extracted*

- **Scope note:** Pairs with reviewed_by for the sign-off audit trail. Fires on any decision outcome, not just approval.

#### `Staging_incidents.artifact_id`

*Not AI-extracted*


#### `Staging_incidents.incident_description_raw`

*Verbatim*

- **Scope note:** Verbatim narrative. May itself contain the dates, alcohol/drug involvement, or findings — extract those into their own fields too, but keep this text intact and complete.
- **Normalization rule:** Preserve full text including paragraph breaks. Do not summarize or truncate.
- **Extraction disambiguation rule:** Capture the institution's full narrative verbatim, preserving paragraph breaks; do not summarize, truncate, or paraphrase. This text often also contains the incident date(s), alcohol/drug involvement, and/or the finding — populate those fields from it while leaving this narrative whole. Where an institution merges 'Findings, Incident Descriptions, and Incident Dates' into one block, keep the full block here and also fill the discrete fields from it. Do not paste this narrative verbatim into findings or sanctions; those take only their specific value. If no description is present, leave genuinely null (not 'Not specified' text — corrected August 17, 2026, since this field is displayed directly to the public) and write a Staging_Incident_Review_Flags row with flag_type = 'Legally required field missing'.
- **Missing value handling:** Leave null and flag for review if absent.
- **Example label variants seen:**  Incident Summary; Summary; Description of Violation; Description of Conduct; General Description of; Hazing Incident; Incident Description; Description; Description of Incident; Description of incident(s); A general description of the incident(s), including the date of the initial violation, the determination of responsibility, and the outcomes assigned to the organization if applicable
- **Example output value:** 9/20/2025: A new member was required by the chapter to carry an object at all times, which can create
fear of repercussions.
9/27/2025: The organization co-hosted a social event during which hard alcohol was present and consumed by a minor. ID checks were not conducted, and wristbands were not distributed. Risk management did not adequately prevent consumption of hard alcohol.

#### `Staging_incidents.staging_incident_id`

*Not AI-extracted*


#### `Staging_incidents.sanctions_raw`

*Verbatim*

- **Scope note:** The consequences (probation, suspension, education, etc.) and any timelines. Distinct from findings — this is what happens to them as a result.
- **Normalization rule:** Preserve verbatim including any list structure and dates/timelines within.
- **Extraction disambiguation rule:** Capture the institution-imposed consequences verbatim, preserving list structure and any embedded timelines/dates. Labels vary — use the section describing what happens to the organization, whatever its label. If sanctions appear only inside the description, extract them here without relocating the narrative. If none are stated, leave genuinely null (not 'Not specified' text — corrected August 17, 2026).
- **Missing value handling:** Leave null. Flag conditionally, not always (corrected August 17, 2026) — write a Staging_Incident_Review_Flags row with flag_type = 'Legally required field missing' only when determination_status is 'Determined hazing'. The Act requires sanctions only "as applicable"; a Dismissed or Not specified determination legitimately has none to report.
- **Example label variants seen:** Sanctions; Details of the assigned outcomes and the timeline for completion; Sanctions placed on organization; University Sanctions or Court Fines; Resolution; Accountability actions assigned; Sanctions Imposed; Outcomes
- **Example output value:** • Effective immediately (November 14, 2025), you have been placed on disciplinary probation through May 15, 2026. During this probationary period, if you are found responsible for violating any University policy, the violation will be dealt with more severely.
• A revised risk management plan to be submitted to this office. In addition, a revised event registration plan will also be submitted. No pending event registration forms will be approved until these documents are submitted.
• For Fall 2026 New Member education, there will be a curfew in which new members should not be in the chapter house. The prohibited time is 11:00pm to 7:00pm starting on Sunday night and ending on Friday morning. The prohibition will remain in place until the new members are initiated.
• The Chapter (up to 60 members and/or new members) will participate in the "10 Signs of a Healthy and Unhealthy Group" workshop facilitated by University staff prior to March 9, 2026. All participants will be expected to complete the pre-assessment, post-assessment, and 4-week after survey associated with the workshop. CRSC will contact you will potential dates for the event.

#### `Staging_incidents.investigation_start_date`

*Inferred*

- **Scope note:** The start of the investigation, distinct from the date it was reported and the date it concluded.
- **Normalization rule:** Normalize to YYYY-MM-DD. If a single 'Dates of Investigation: A - B' range is given, A = this field, B = investigation_end_date.
- **Extraction disambiguation rule:** Normalize to YYYY-MM-DD. MERGE case: if one combined range is given ('Dates of Investigation: A - B', 'Investigation Initiated and Investigation Concluded'), assign the earlier date A here and the later date B to investigation_end_date. Strip the label from embedded values. This is when the investigation began — do not use the incident date or the date the institution first received the report. If absent, leave genuinely null (a Date-typed column can't hold text at all — corrected August 17, 2026); investigation_start_date_raw carries the verbatim/null fallback instead.

#### `Staging_incidents.extraction_confidence`

*Inferred*

- **Normalization rule:** Store as reported by the model, 0.0–1.0, one value per incident.
- **Extraction disambiguation rule:** If below 0.7, write a Staging_Incident_Review_Flags row with flag_type = 'Low extraction confidence'. Threshold is provisional — see Open questions and decisions.
- **⚠️ Open question:** Threshold is provisional: starting at <0.7 triggers a flag. This is a starting point, not a settled standard — a self-reported LLM confidence score is not a true calibrated probability, so the real validation is checking the first batch of reviewed incidents: if low-scored incidents keep coming back clean, raise the threshold; if mid-range scores keep having real errors, lower it. Revisit after first review cycle. Currently exists in Mahir's extraction prompt (as of July 7, 2026) as a document-level score (one per CHTR page, in the same JSON object as is_chtr) — needs to move to per-incident, since a single CHTR can report multiple incidents and the review flag this drives (Staging_Incident_Review_Flags, flag_type = 'Low extraction confidence') is scoped per-incident, not per-document. 

#### `Staging_incidents.investigation_end_date_raw`

*Verbatim*

- **Scope note:** Preserved verbatim as a fallback/audit trail — lets a human check the original wording if the normalized date is ever in question. Genuinely null when absent, never a "Not Specified" placeholder string — corrected August 17, 2026.
- **Normalization rule:** Capture exactly as written, trim whitespace
- **Extraction disambiguation rule:** Look for labels like 'Investigation Concluded,' 'Date of Responsible Finding,' or 'Resolution Date' (see investigation_end_date's merge-case rule for combined-label handling). Capture verbatim, including any embedded finding/resolution language that accompanies the date.
- **Missing value handling:** Leave genuinely null (not 'Not Specified' text — corrected August 17, 2026) if no investigation end date is stated anywhere in the source, and write a Staging_Incident_Review_Flags entry with flag_type = 'Legally required field missing' — investigation dates are legally required in CHTRs, so absence here is a compliance gap worth reviewer attention.

#### `Staging_incidents.institution_unitid`

*Not AI-extracted*


#### `Staging_incidents.determination_status`

*Inferred*

- **Scope note:** A content field describing what happened in the real world, distinct from human_review_status (whether a human reviewer has signed off on the record as accurate for the public table) and from reviewed_by/reviewed_date (audit — who did that sign-off and when). 
- **Extraction disambiguation rule:** Resolve from the Findings section (or equivalent) first. A clear statement the organization was found responsible for a hazing violation means Determined Hazing. A clear statement the case was dismissed or not found responsible means Dismissed. Investigation explicitly still open or ongoing means Pending. If the Findings section instead just lists policies violated without a clear hazing-specific determination, or no Findings section exists at all, this is the 'Determination unclear' case — write a Staging_Incident_Review_Flags row with flag_type = 'Determination unclear' rather than guessing.
- **Missing value handling:** Output 'Not specified' if the institution's report doesn't clearly state a determination.
- **Controlled vocabulary terms:** Dismissed; Pending; Determined hazing; Not specified

#### `Staging_incidents.notice_date_raw`

*Verbatim*

- **Scope note:** Preserved verbatim as a fallback/audit trail — lets a human check the original wording if the normalized date is ever in question. Genuinely null when absent, never a "Not Specified" placeholder string — corrected August 17, 2026.
- **Normalization rule:** Capture exactly as written, trim whitespace
- **Extraction disambiguation rule:** Look for a label distinct from the investigation conclusion date itself — 'Notice to Organization,' 'Date Organization Notified.' This field is absent more often than present; only extract a value if the source clearly labels a separate notice event (see notice_date's merge-case rule for when it's combined with the finding date instead). Capture verbatim.
- **Missing value handling:** Leave genuinely null (not 'Not Specified' text — corrected August 17, 2026) if the source has no separately-labeled notice field matching the pattern described below — this is common and not itself a compliance flag, since the notice date may still be recoverable via notice_date's merge-case logic or from narrative text elsewhere in the document. Do not flag here; the compliance check happens at notice_date once all recovery paths are exhausted.

#### `Staging_incidents.reviewed_by`

*Not AI-extracted*

- **Scope note:** Pairs with human_review_status and reviewed_date as the audit trail for that sign-off. 

#### `Staging_incidents.findings_raw`

*Verbatim*

- **Scope note:** The adjudicated outcome (policies violated, finding categories). Distinct from sanctions (the consequences) and from the incident description (the alleged conduct).
- **Normalization rule:** Preserve verbatim. 
- **Extraction disambiguation rule:** The source may have no labeled findings field. Resolve in order: (1) a labeled findings / 'found responsible' / 'policy violated' field; (2) the determination of responsibility within the incident description; (3) within the sanctions/outcome text. Capture only the finding — the policy/policies violated and the responsibility determination — not the conduct narrative (stays in incident_description) or the consequences (go to sanctions). If no finding appears anywhere, leave genuinely null (not 'Not specified' text — corrected August 17, 2026) and write a Staging_Incident_Review_Flags row with flag_type = 'Legally required field missing'. Do not paste the full description into this field.
- **Missing value handling:** Leave null if absent; some institutions fold findings into description or sanctions.
- **Example label variants seen:** Findings; Findings & Sanctions; University or Court Findings; Findings;
Policy(s) the organization was found responsible for violating; Findings of the Institute; Findings; Findings, Incident Descriptions, and Incident Dates; Violations; Informal Disposition ;Charges with Responsible Finding
- **Example output value:** Phi Delta Theta was found responsible for violating CRR 200.010.C.19 Hazing policy.

#### `Staging_incidents.drugs_involved`

*Inferred*

- **Scope note:** The drug half of the federal alcohol-or-drug data point, modeled as its own field alongside alcohol_involved. Same normalization and source-pattern handling as alcohol_involved.
- **Normalization rule:** Map to the controlled vocabulary (Yes / No / Not specified). Populate independently of alcohol_involved.
- **Extraction disambiguation rule:** Populate independently of alcohol_involved using the same source patterns: (1) a per-substance field maps directly, no flag needed. (2) a combined 'alcohol and/or drugs' field — first attempt to allocate drugs specifically from any accompanying description/findings/sanctions text. Never infer 'No' for drugs from silence alone — if the text names alcohol but never mentions drugs, drugs stays 'Not specified', not 'No'; only set 'No' if the source explicitly rules drugs out. If allocation genuinely fails, set BOTH alcohol_involved and drugs_involved to 'Unable to determine - Unclear reporting' together (added August 17, 2026) — same reasoning as alcohol_involved. If the combined field is affirmative (Yes), ALWAYS write a Staging_Incident_Review_Flags row with flag_type = 'Alcohol/drugs review needed' regardless of whether allocation succeeded — same reasoning as alcohol_involved: a combined 'Yes' is structurally ambiguous even when the AI feels confident in its read. If the combined field is 'No', no flag is needed — that answer is unambiguous and applies cleanly to both fields. (3) involvement stated only in the description, no labeled field — read it from that text; flag only if genuinely unrecoverable. Output 'Not specified' on silence, never 'No' by default. Genuine plain silence (source never addresses alcohol/drugs at all) also writes a Legally required field missing flag, distinct from the combined-affirmative case's Alcohol/drugs review needed flag (added August 17, 2026).

Bar for setting 'Yes' from narrative text (cases 2 and 3): only set 'Yes' if the source unambiguously indicates drug use — e.g., 'found unresponsive from drug use,' 'tested positive for [substance],' 'under the influence of drugs.' Do not infer 'Yes' from adjacent context alone (e.g., 'party,' 'social event') without an explicit indication of actual use or intoxication — scene-setting language is not evidence of involvement.
- **Missing value handling:** Output 'Not specified' when drugs are neither stated nor implied; never infer 'No' from silence.
- **Controlled vocabulary terms:** Yes; No; Not specified; Unable to determine - Unclear reporting
- **Example label variants seen:** Did the Violation Involve the Abuse or Illegal Use of Alcohol or Drugs?; Drug/Alcohol Involvement; Was the abuse or illegal use of alcohol or drugs involved?; Drug use

### Staging_organizations

AI-proposed candidate organizations, reviewed and promoted independently of the incident(s) that reference them — an incident and its organization can be approved in either order.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `staging_organization_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the Staging_Organizations table. Auto-generated at insert. |
| `match_type` | Enum (Controlled vocab) | No | Pipeline-populated at extraction/matching time | Whether this candidate organization_name matched an existing public Organizations record, or is a genuinely new proposal with no match found. |
| `organization_type` | Enum (Controlled vocab) | No | AI-inferred then human-confirmed during review | The candidate category of the student organization for this candidate record. |
| `membership_gender_composition` | Enum (Controlled vocab) | No | AI-inferred then human-confirmed during review | New August 17, 2026. The candidate's self-identified gender-identity category for membership — see Organizations.membership_gender_composition. |
| `reviewed_date` | Date (YYYY-MM-DD) | Yes | Pipeline-populated, automatically, at the moment human_review_status changes to Approved or Rejected | The date the reviewer set human_review_status to Approved or Rejected for this Organization record. |
| `human_review_status` | Enum (Controlled vocab) | No | Defaults to "Proposed" at creation (pipeline); set by human reviewer at review time | The reviewer's sign-off verdict on whether a pipeline-proposed Organization record is confirmed, incorrect, or still awaiting review. |
| `reviewer_notes` | Text | Yes | Human-entered, at review time | Free-text notes a reviewer leaves when reviewing a proposed Organization record — why it was rejected, what was corrected before approval, or any other context worth preserving. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when this organization record was proposed and staged. |
| `reviewed_by` | Text | Yes | Human-entered, at review time | The reviewer who set human_review_status to Approved or Rejected for this Organization record. |
| `organization_name` | Text | No | Pipeline-populated: copied from the matched existing Organizations.organization_name record, or copied from Staging_Incidents.organization_name_normalized if no match is found (matching itself runs on both values after the match-time safety-net normalization pass — see Normalization format rule). | The candidate organization name shown to the reviewer and used to create or link to a public Organizations record — copied by the pipeline from either a matched existing record or the AI's normalized candidate, never generated by AI directly on this table. |


#### `Staging_organizations.staging_organization_id`

*Not AI-extracted*

- **Scope note:** Referenced by Incident_Organizations.staging_organization_id (FK).

#### `Staging_organizations.match_type`

*Not AI-extracted*

- **Scope note:** Since every Staging_Organizations row is shown to the reviewer regardless of match outcome (no silent auto-approval), this field gives the reviewer fast-path context — a clean repeat match to an already-approved org vs. a genuinely new name needing real scrutiny — without conflating that with human_review_status itself.
- **Controlled vocabulary terms:** Matched existing; New proposal

#### `Staging_organizations.organization_type`

*Inferred*

- **Scope note:** Stores the reviewer-confirmed organization type, drawn from the Organization Type controlled vocabulary (see Controlled Vocabularies tab for full term definitions and per-term scope notes/checkable signals). AI-inferred at extraction time from the org's own self-description within a CHTR entry, then confirmed or corrected by the human reviewer during review — this is not a verified external classification (e.g. not cross-checked against an official student org registry).
- **Normalization rule:** Store the controlled vocabulary term exactly as listed (e.g. 'Academic club', not 'academic club' or 'Academic Club'). Do not store free-text descriptions, multiple terms, or hedged/uncertain categorizations in this field — reasoning, ambiguity, or low confidence in the categorization belongs in reviewer_notes, not organization_type.
- **Extraction disambiguation rule (rewritten August 17, 2026 for the new 18-term vocabulary — replaces the prior 5-step rule):** Where multiple categories could plausibly apply, resolve in this priority order, checked until one applies: (1) Greek self-identification — split by induction mechanism (merit-based → Honor society) and purpose (social vs. service/professional fraternity or sorority); (2) explicit ROTC/Corps naming, including bare alphanumeric unit designations with no descriptive text (e.g. 'C-Battery,' 'Squadron 17,' 'A-1,' 'K-2') — these are valid organization names under this category, not unclassifiable; (3) marching-band-affiliated performance units vs. independently organized performing arts groups — when the source doesn't state organizational affiliation (common), lean on the org's own name/self-description rather than guessing at an administrative relationship; (4) culturally-based/identity-based organizations, deferring to (1) if Greek-lettered; (5) faith-based framing, with an explicit carve-out for organizations whose primary stated function is welcoming/mentoring incoming students (those fold into Other type of organization, not Faith-based, even under religious framing); (6) student government/institutional leadership naming (e.g. 'Student Government,' 'Senate') vs. Honor society — lean on explicit representative-body naming, since a CHTR incident rarely states an org's actual governing authority; (7) campus media naming vs. political/single-cause advocacy framing — lean on the org's own name/self-description, since publication history/ongoing-vs-one-off status is rarely stated; (8) academic discipline tie without a leadership/selectivity mission; (9) non-Greek community service; (10) sports, split three ways by administering office: Athletics department → Varsity athletic team; Campus Rec/Student Life, competing externally → Club sport; Campus Rec, in-house only → Intramural or recreation sports team; (11) Social club as a catch-all after ruling out the above; (12) Other type of organization as the final residual.
- **Missing value handling:** Leave organization_type blank/NULL when not determinable at extraction time. Do not output a placeholder value such as 'Unknown' — this is not a valid controlled vocabulary term. Surfaced to reviewers via a Staging_Incident_Review_Flags row with flag_type = 'Unable to determine organization type' (resolved — see the Flag type controlled vocabulary section below).
- **Controlled vocabulary terms (replaced August 17, 2026 — see below):** Social fraternity or sorority; Service or professional fraternity or sorority; Varsity athletic team; Club sport; Intramural or recreation sports team; Honor society; Academic club; Performing arts organization; Marching band; ROTC or other military organization; Social club; Faith-based organization; Culturally-based / identity-based organization; Student government or other student leadership organization; Community service organization; Political organization or social action group; Campus media organization; Other type of organization

#### `Staging_organizations.membership_gender_composition`

*Inferred*

- **Scope note:** New August 17, 2026. Candidate value for the organization's self-identified gender-identity category — see Organizations.membership_gender_composition for the full reasoning (identity-based, not sex-assigned-at-birth; name-inference caution for "fraternity" vs. "sorority").
- **Normalization rule:** Defaults to "Unknown-Not stated" when the source doesn't clearly indicate composition.
- **Controlled vocabulary terms:** All-male; All-female; Mixed-Co-ed; Unknown-Not stated
- **Correction path:** A new `corrected_membership_gender_composition` field was added to organization_review, mirroring the existing corrected_organization_type pattern — reviewers can correct this field the same way they can already correct organization_type. rebuild.py's organization-promotion logic prefers the correction over the extracted value when present.

#### `Staging_organizations.reviewed_date`

*Not AI-extracted*


#### `Staging_organizations.human_review_status`

*Not AI-extracted*

- **Scope note:** Mirrors Staging_incidents.human_review_status — new Organization records are proposed automatically at extraction time (per the matching-at-extraction-time decision), and this field is the human gate on whether that proposal is real. Rejected records are kept, not deleted — they're the audit trail of where AI extraction is getting organization names/types wrong, useful for improving the extraction prompt over time. 
- **Controlled vocabulary terms:** Proposed; Approved; Rejected

#### `Staging_organizations.reviewer_notes`

*Not AI-extracted*

- **Scope note:** Mirrors Staging_Incidents.reviewer_notes — this is what makes the Organization audit trail actually actionable for improving how the AI proposes/matches organization names over time, rather than just a bare Approved/Rejected count with no explanation of why.

#### `Staging_organizations.created_at`

*Not AI-extracted*

- **Scope note:** Marks when the AI actually proposed this organization record — distinct from reviewed_date, which marks when a human reviewed it. The gap between the two is how long this record sat in the review queue.

#### `Staging_organizations.reviewed_by`

*Not AI-extracted*


#### `Staging_organizations.organization_name`

*Not AI-extracted*

- **Scope note:** Distinct from Staging_Incidents.organization_name_raw (verbatim, chapter/legal-suffix preserved) AND from Staging_Incidents.organization_name_normalized (the AI's cleaned candidate). This field is a pure pipeline copy, not AI-produced — either the name from a matched existing Organizations record, or organization_name_normalized itself when no match is found. This is what the human reviewer actually sees/confirms/corrects during the Approved/Rejected review pass.
- **Normalization rule:** Stored with proper capitalization preserved, as-is from whichever source populated it — never stored in the lowercased/stripped form used for matching. MATCH-TIME SAFETY NET: before comparing organization_name_normalized against existing Organizations.organization_name values, the pipeline applies a final deterministic pass to BOTH sides for comparison purposes only (lowercase, trim whitespace, strip stray punctuation) — this guards against small AI inconsistencies across separate extractions of the same real organization (e.g. a stray trailing period, inconsistent spacing) without asking the AI to be perfectly rigid. This safety-net pass never changes what gets stored in this field; it only affects whether a match is found.

### Staging_incident_possible_matches

Pipeline-detected candidate duplicate/update pairs between a new Staging_incidents row and an existing public Incidents row, found via two lookup keys before/alongside staging.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `existing_incident_id` | Integer (FK → Incidents.incident_id) | No | Pipeline-populated | Foreign key pointing to the pre-existing incident record that the new incident record matched against. |
| `match_basis` | Enum (Controlled vocab) | No |  | The reason this pair of incident records was flagged as a possible match (such as they have matching "unitid+end_date"). |
| `candidate_incident_id` | Integer (FK → Staging_Incidents.staging_incident_id) | No | Pipeline-populated at extraction/pre-insert time | Foreign key pointing to the new incident record that seems to be a possible duplicate of an existing incident record. |
| `match_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for this candidate-match record. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when the pipeline's matching step found this candidate/existing pair. |


#### `Staging_incident_possible_matches.existing_incident_id`

*Not AI-extracted*

- **Scope note:** Together with candidate_incident_id, this row is the whole signal for a "Duplicate match" — shown to the reviewer for context, not acted on automatically; it does not imply the candidate is rejected or merged. For a "Status update to Pending incident" match specifically (match_basis), this existing_incident_id is the record that gets updated in place — not inserted as a new row — once the reviewer approves the candidate.

#### `Staging_incident_possible_matches.match_basis`

*Not AI-extracted*

- **Scope note:** Two values, distinguished by an automatic status comparison at match-detection time — not by which key caught the match, and not left to the reviewer to notice. Whenever a match is found (via either the primary key, unitid + end_of_investigation_date, or the second key, unitid + organization + incident_start_date), the pipeline compares the candidate's extracted determination_status against the existing incident's CURRENT determination_status: if they match, this is "Duplicate match" (visibility only, shown to the reviewer for context, never acted on automatically — covers both a true re-extraction of unchanged content and the coincidental same-date-different-incident case). If they differ, this is "Status update to existing incident" — the incident's outcome has actually changed, regardless of what the prior status was (Pending resolving to a determination, or an already-resolved incident being corrected/revised, e.g. on appeal). This value changes what promotion does: if the reviewer approves the candidate record (via the normal Staging_Incidents.human_review_status gate — the same human-review step every incident goes through, not a separate approval), the promotion step does NOT insert a new public Incidents row. Instead it updates the existing Incidents row's determination_status and updated_at in place, and writes a row to Incident_status_history recording the change (old_status → new_status). The candidate's own Staging_Incidents record remains staging-only — it never becomes its own public row.
- **Controlled vocabulary terms:** Duplicate match; Status update to existing incident

#### `Staging_incident_possible_matches.candidate_incident_id`

*Not AI-extracted*

- **Scope note:** Written by the pipeline's matching step (a SELECT before an INSERT) — never by a human. One row is written per existing incident this candidate record collides with, so a single candidate record can generate more than one row in this table.

#### `Staging_incident_possible_matches.match_id`

*Not AI-extracted*


#### `Staging_incident_possible_matches.created_at`

*Not AI-extracted*


### Staging_incident_review_flags

Append-only, AI- and pipeline-populated flags surfacing things a reviewer should look at (missing fields, low confidence, ambiguous alcohol/drug involvement, etc.) for either an incident or an organization.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `resolved_at` | TIMESTAMPTZ | Yes | Pipeline-populated, at recheck time following a reviewer edit | Timestamp of when this flag's triggering condition was confirmed resolved — blank if the flag is still active. |
| `field_name` | Text | No | AI-reported per flags array entry (see Pipeline Logic: 'AI-triggered review flags (flags array mechanism)'), then pipeline-populated at INSERT time | The specific field (literal column name) that this flag pertains to — e.g. 'organization_name_raw', 'findings_raw', 'organization_type'. Distinct from flag_type, which describes the category/reason for the flag; field_name identifies exactly which column triggered it, so a single flag_type (like 'Legally required field missing') can be traced back to the specific field responsible. |
| `flag_id` | Integer (PK, auto-generated) | No | System-generated at insert | Primary key for the review flag record. |
| `flag_type` | Enum (Controlled vocab) | No | Pipeline-populated (one row inserted per detected reason) | Controlled-vocabulary term describing why this record needs review. Originally scoped to incidents only; now also covers organization-level review reasons (e.g. undetermined organization_type) now that this table's scope is being extended to organizations — see open questions on the organization_type field. |
| `staging_incident_id` | Integer (FK → Staging_incidents.staging_incident_id) | Yes | Pipeline-populated | Foreign key pointing to the Staging_Incidents.incident record this flag applies to. |
| `staging_organization_id` | Integer (FK → Staging_organizations.staging_organization_id) | Yes | Pipeline-populated | Foreign key pointing to the Staging_Organizations record this flag applies to, when the flag concerns an organization rather than an incident. |
| `created_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when this flag was written. |


#### `Staging_incident_review_flags.resolved_at`

*Not AI-extracted*

- **Scope note:** Not a manually-managed resolution workflow — decision #10 already rejected that (flags are pure append-only visibility signals, no reviewer-tracked status). This is different: a system-set timestamp, written automatically the moment a post-edit recheck confirms the triggering condition no longer holds. A reviewer never sets this directly. The review screen only shows flags where this is blank; a flag that resolves keeps its row (queryable history of what got flagged and whether a human fix cleared it) rather than being deleted.

#### `Staging_incident_review_flags.field_name`

*Inferred*

- **Scope note:** Applies to flags on both incidents and organizations now that this table covers both record types. Should always be populated — every flag pertains to a specific field, even when the flag_type describes a broader category spanning multiple possible fields.
- **Normalization rule:** Store the literal database column name exactly as it appears in the schema (e.g. 'organization_type'), not a human-readable display label or description.
- **Missing value handling:** Should not be blank. Every flag row must specify the field it pertains to; a flag with no field_name is itself a data-quality problem in the flag-writing logic, not a valid state.

#### `Staging_incident_review_flags.flag_id`

*Not AI-extracted*


#### `Staging_incident_review_flags.flag_type`

*Not AI-extracted*

- **Scope note:**  Possible duplicates are not tracked as a flag_type value here — that signal lives in the separate the possible matches table instead, so the two tables never overlap. An incident can have multiple rows in this table if it needs review for more than one reason at once (one row per reason); this field itself only ever holds a single value per row.
- **Controlled vocabulary terms:** Low extraction confidence; Determination unclear; Legally required field missing; Unable to derive value; Alcohol/drugs review needed; Unrecognized date term; Unable to determine organization type

#### `Staging_incident_review_flags.staging_incident_id`

*Not AI-extracted*

- **Scope note:** An incident can have multiple rows in this table if flagged for more than one reason at once. Now nullable: since this table also covers organization-level flags (see staging_organization_id), a flag row about an organization (e.g. 'Unable to determine organization type') will leave this field blank instead.

#### `Staging_incident_review_flags.staging_organization_id`

*Not AI-extracted*

- **Scope note:** Exactly one of staging_incident_id or staging_organization_id is populated per row, never both, never neither. A flag about an organization (e.g. flag_type = 'Unable to determine organization type') populates this field and leaves staging_incident_id blank. This is a pipeline-code responsibility, not a database constraint — consistent with the decision not to enforce organization_type completeness via constraint either.

#### `Staging_incident_review_flags.created_at`

*Not AI-extracted*


### Staging_incident_corrections

Append-only audit log, one row per individual field a reviewer corrects — the raw material for measuring which fields the AI gets wrong most often.


| Field | Data type | Nullable | Populated by | Definition |
|---|---|---|---|---|
| `correction_type` | Array (Controlled vocab, text[]) | No | Human-entered, at review time (one selection per save action) | Whether the reviewer considers this correction minor cleanup, or a genuine AI extraction error worth studying to improve the prompt. |
| `corrected_at` | TIMESTAMPTZ | No | Pipeline-populated | Timestamp of when this correction was saved. |
| `staging_incident_id` | Integer (FK → Staging_Incidents.staging_incident_id) | No | Pipeline-populated | Foreign key pointing to the Staging_Incidents record this correction was made on. |
| `corrected_value` | Text | No | Human-entered, at review time | The reviewer's corrected value. |
| `field_name` | Text | No | Pipeline-populated | The name of the Staging_Incidents (or related table) field that was corrected. |
| `original_value` | Text | No | Pipeline-populated | The AI's original extracted value before this correction. |
| `corrected_by` | Text | No | Human-entered, at review time | The reviewer who made this correction. |
| `staging_incident_correction_id` | Integer (PK, auto-generated) | No | System-generated at insert | Surrogate primary key for this correction record. |


#### `Staging_incident_corrections.correction_type`

*Not AI-extracted*

- **Scope note:** Set once per cluster-edit action (see field_name for cluster definitions), not once per individual field — and not restricted to a single value. Multi-select: a reviewer can tag a cluster edit as BOTH "Minor cleanup" and "Extraction error" simultaneously (e.g. fixing a typo in one field of the cluster while also correcting a genuine AI miss in another field of the same cluster), or just one. Whatever is selected applies to every field-correction row written from that cluster's save — only fields actually changed get a row; untouched fields in the same cluster are never logged.
- **Controlled vocabulary terms:** Minor cleanup; Extraction error

#### `Staging_incident_corrections.corrected_at`

*Not AI-extracted*


#### `Staging_incident_corrections.staging_incident_id`

*Not AI-extracted*

- **Scope note:** The record being corrected during review.

#### `Staging_incident_corrections.corrected_value`

*Not AI-extracted*


#### `Staging_incident_corrections.field_name`

*Not AI-extracted*

- **Scope note:** One row per corrected field, not per cluster-edit action or per review session — this grain is what makes the table useful for prompt-improvement analysis ("which specific field does the AI get wrong most often"). Only fields actually changed in a save get a row; untouched fields in the same cluster are never logged, even if they were available to edit together.

CLUSTERS (fields opened together for editing, per the review interface — not a stored field, just how the edit action is grouped): Incident start date (start_date_raw, start_date_normalized, start_date_precision); Incident end date (end_date_raw, end_date_normalized, end_date_precision); Investigation start date (investigation_start_date, investigation_start_date_raw); Investigation end date (investigation_end_date, investigation_end_date_raw); Notice date (notice_date, notice_date_raw). Every other field is its own single-field cluster. correction_type is selected once per cluster-edit action (see that field), applied to whichever fields within the cluster were actually changed.

#### `Staging_incident_corrections.original_value`

*Not AI-extracted*


#### `Staging_incident_corrections.corrected_by`

*Not AI-extracted*


#### `Staging_incident_corrections.staging_incident_correction_id`

*Not AI-extracted*


## Pipeline logic

Rules that live in pipeline code rather than in any single column — cross-table behavior, triggers, and decisions the AI model does not make on its own.


### AI extraction / pipeline ingestion


**Organization-level flags now share the incident review flags table**
- Tables/fields involved: Staging_incident_review_flags.staging_organization_id, .field_name, .flag_type; Staging_organizations.organization_type
- Trigger: AI extraction leaves Staging_organizations.organization_type blank (unable to confidently classify)

Staging_incident_review_flags now covers both incidents and organizations, not incidents alone. When the AI cannot confidently assign an organization_type, it leaves the field blank and reports a flags array entry with flag_type = 'Unable to determine organization type' and field_name = 'organization_type'. The pipeline inserts one row into Staging_incident_review_flags with staging_organization_id populated and staging_incident_id left blank. Exactly one of staging_incident_id / staging_organization_id is populated per row — this is a pipeline-code responsibility, not a database constraint (same approach as leaving organization_type itself unconstrained).


**AI-triggered review flags (flags array mechanism)**
- Tables/fields involved: Staging_Incident_Review_Flags (all fields); AI extraction prompt output schema (needs a top-level or per-incident 'flags' array); Staging_incidents.organization_name_raw, .sanctions_raw, .findings_raw, .alcohol_involved, .drugs_involved, .determination_status, .investigation_start_date_raw, .investigation_end_date_raw, .notice_date; Incident_dates.start_date_raw, .end_date_raw, .start_date_normalized, .end_date_normalized
- Trigger: Any extraction rule in the Data Dictionary that says 'write a Staging_Incident_Review_Flags row' — this fires during the AI extraction pass, before pipeline ingestion.

The AI cannot write directly to the database — it only returns JSON. Every extraction rule that says 'the AI writes a flag row' actually means: the AI's output JSON must include a structured 'flags' array (scoped per-incident) where each entry specifies at minimum a flag_type (from the controlled flag_type vocab) and the field_name it relates to, plus an optional note. The ingestion pipeline then reads this array after the AI call returns and is what actually performs the INSERT into Staging_Incident_Review_Flags — one row per array entry. This mechanism applies globally to every field listed in Tables/fields involved, not just one field — the extraction prompt needs a 'flags' array defined in its output schema to support all of these at once.

Exception notes (not evident from the field list alone): notice_date only writes a flag after its 3-step resolution order (separate label → merge case → narrative text) fails to find a value — it does not flag on first absence. start_date_normalized/end_date_normalized use flag_type = 'Unrecognized date term' specifically, not 'Legally required field missing', for unmapped academic-term names. alcohol_involved/drugs_involved's 'Alcohol/drugs review needed' flag is triggered by the SOURCE structure, not the resolved output — it fires when the source presents alcohol and drugs as one combined/labeled field (e.g. 'Alcohol/drug use') that comes back affirmative, regardless of whether allocation to the individual fields succeeded. It does NOT fire simply because alcohol_involved or drugs_involved individually resolves to Yes from a separately-labeled source field — that case is unambiguous and needs no flag.

Cascading fields: start_date_precision/end_date_precision do NOT independently write a flag when they output 'Unknown' due to a missing raw date — that flag is already written once by start_date_raw/end_date_raw's own rule for the same underlying gap. Avoid duplicate flag rows for a single root cause.

Keep Tables/fields involved in sync as new flag-writing rules are added to the Data Dictionary.


### Audit auto-fill


**reviewed_by / reviewed_date auto-fill on review decision**
- Tables/fields involved: Staging_incidents.reviewed_by, Staging_incidents.reviewed_date, Staging_organizations.reviewed_by, Staging_organizations.reviewed_date, Staging_incidents.human_review_status, Staging_organizations.human_review_status
- Trigger: human_review_status changes to Approved or Rejected

Auto-fill both fields the instant human_review_status changes — on Staging_Incidents and Staging_Organizations alike, both now using the same Approved/Rejected vocabulary. Never manually entered by the reviewer.


### Extraction & Matching


**Organization name: AI cleans, pipeline copies + safety net**
- Tables/fields involved: Staging_incidents.organization_name_raw, Staging_incidents.organization_name_normalized, Staging_Organizations.organization_name, Organizations.organization_name
- Trigger: AI extraction proposes an organization

The AI produces organization_name_normalized (chapter/legal-suffix stripped, proper capitalization preserved) in the same extraction pass as organization_name_raw — this is genuine AI judgment, since the model has full document context. Staging_Organizations.organization_name is then a pure pipeline copy: either the matched existing Organizations name, or organization_name_normalized itself if no match. Before comparing for a match, apply a final deterministic pass to BOTH sides (lowercase, trim, strip punctuation) for comparison purposes only — never changing what's actually stored.


**Review flag conditions: model reports the value, pipeline applies the threshold**
- Tables/fields involved: Staging_Incident_Review_Flags.flag_type, Staging_incidents.extraction_confidence, Staging_incidents.alcohol_involved, Staging_incidents.drugs_involved
- Trigger: A staged incident is evaluated for review flags

Four conditions, each with a different split between what the model reports and what pipeline code decides: Legally required field missing (pipeline checks for empty org/description/findings/sanctions) — Alcohol/drugs review needed (fires whenever a combined alcohol-or-drugs field resolves to Yes, regardless of whether the model successfully allocated between the two substances; no flag if the combined answer is No) — Low extraction confidence (model self-reports extraction_confidence per incident; pipeline applies the <0.7 threshold, which is provisional pending calibration) — Determination unclear (model couldn't confidently resolve hazing/pending/dismissed). The threshold/presence-check logic must be pipeline code, not left to the model's discretion.


**Pre-insert candidate-match check (both keys)**
- Tables/fields involved: Staging_incidents, Incidents, Staging_incident_possible_matches
- Trigger: AI extraction produces a Staging_Incidents row

Before/alongside staging the new incident, look up existing public Incidents on unitid + end_of_investigation_date (primary key) AND unitid + organization + incident_start_date (second key, catches Pending incidents that lack an end_of_investigation_date). A miss means nothing further happens. A hit writes a Staging_incident_possible_matches row — this is deterministic pipeline code (a SELECT before an INSERT), not something the AI model decides.


**Organization proposal: always create, never auto-approve**
- Tables/fields involved: Staging_Organizations, Incident_Organizations, Staging_Organizations.match_type
- Trigger: AI extraction identifies an organization in an incident

Always write a Staging_Organizations row and an Incident_Organizations join row, regardless of match confidence — including a clean, obvious match to an already-approved organization. There is no confidence threshold that skips human review; match_type (Matched Existing / New Proposal) just gives the reviewer fast-path context on which kind it is.


**Automatic status comparison sets match_basis**
- Tables/fields involved: Staging_incident_possible_matches.match_basis, Staging_incidents.determination_status, Incidents.determination_status
- Trigger: A candidate match is found (either key)

Compare the candidate's extracted determination_status against the existing incident's CURRENT determination_status — not which key caught the match. IF the statuses match: match_basis = 'Duplicate match' (visibility only, never acted on automatically). IF the statuses differ: match_basis = 'Status update to existing incident' (triggers the in-place-update promotion branch once approved). This must be automatic — never left for the reviewer to notice on their own.


### Promotion


**Promotion branch: insert new row vs. update existing in place**
- Tables/fields involved: Incidents, Staging_incident_possible_matches.match_basis, Incident_status_history, Incidents.staging_incident_id, Incidents.updated_at
- Trigger: Staging_incidents.human_review_status is set to Approved

Check match_basis on the approved candidate. IF none, or 'Duplicate match': INSERT a new public Incidents row; staging_incident_id is set once, frozen forever (never repointed by a later status update). IF 'Status update to existing incident': do NOT insert a new row. Instead UPDATE the existing Incidents row's determination_status and updated_at in place, and INSERT one Incident_status_history row (old_status, new_status, staging_incident_id = the resolving candidate). The candidate's own Staging_Incidents row stays staging-only. This branch is the core of the whole mechanism — getting it wrong either creates duplicate public incidents or silently fails to record real status changes.


**Organization promotion is independent of incident promotion**
- Tables/fields involved: Incident_Organizations.incident_id, Incident_Organizations.organization_id, Organizations
- Trigger: Either a Staging_Incidents or a Staging_Organizations record is approved

Incident_Organizations.incident_id and .organization_id populate independently, whenever their own respective parent is separately approved — neither side blocks on the other. On Staging_Organizations approval specifically: New Proposal creates an Organizations row; Matched Existing links directly to the existing one.


### Review & Correction


**Flags auto-clear when their condition resolves**
- Tables/fields involved: Staging_incident_review_flags.resolved_at
- Trigger: A recheck runs after a reviewer correction

IF a recheck confirms a flag's triggering condition no longer holds: set resolved_at automatically (system-set only, never reviewer-set directly). The review screen only shows flags where resolved_at is blank. It's a system-set byproduct of the recheck itself, not a to-do list a reviewer tracks.


**Human review: incidents and organizations together, in context**
- Tables/fields involved: Staging_incidents, Staging_Organizations, Staging_Incident_Review_Flags, Staging_incident_possible_matches
- Trigger: A Staging_Incidents record is ready for review

Reviewer sees the incident and any newly-proposed organizations in the same pass, with flags and candidate matches shown in place — not a separate to-do list or a bare approve/reject screen.


**Correction logging: old/new value capture, one row per changed field**
- Tables/fields involved: Staging_incident_corrections (field_name, original_value, corrected_value, correction_type, corrected_by, corrected_at)
- Trigger: A reviewer correction is saved

Log to Staging_Incident_Corrections — one row per field ACTUALLY changed (never untouched fields in the same edited cluster). Each row carries correction_type as an array (Minor cleanup and/or Extraction error can both apply to one save). Old and new value capture must be automatic and reliable even if an edit happens outside whatever review tool gets built — a database trigger is the more robust mechanism maybe?


**Reviewer correction: edit, auto-recheck, re-display before approving**
- Tables/fields involved: Staging_incidents, Incident_dates, Staging_Organizations
- Trigger: Reviewer spots a fixable issue and saves a correction

Corrections happen in structured functions, not raw field edits — fields are opened in logical clusters (e.g. Incident start date: raw + normalized + precision, edited together). Saving a correction must automatically re-run matching and re-evaluate flag conditions, then re-display the record to the reviewer with its current post-edit state (newly-cleared flags, newly-found matches) BEFORE they can commit to Approve. Never left to interface-level instructions (chat or otherwise) to remember to trigger this.


### Scraping & Ledger


**Ledger dedup check per discovered URL**
- Tables/fields involved: Ledger (source_url, fingerprint_content_hash, last_seen_date), Artifacts
- Trigger: Each URL discovered from a scrape

IF the URL is not in the Ledger: create a Ledger row and an Artifact, route to AI extraction. IF the URL is in the Ledger and the hash matches: skip extraction, update last_seen_date only. IF the URL is in the Ledger and the hash differs: update the stored hash, create a new Artifact, route to AI extraction.


**Unconditional scrape, every cycle**
- Tables/fields involved: Data_checks.chtr_index_url, Data_checks.pipeline_run_id
- Trigger: Data_checks row created with a non-blank chtr_index_url

Scrape chtr_index_url regardless of what the checker recorded in Transparency Report or any other human judgment field. Gating the scrape itself (not just AI extraction) on a human field was an earlier design mistake — it silently misses late-posted reports and quiet revisions.


**Boilerplate/date-token stripping before hashing**
- Tables/fields involved: Ledger.fingerprint_content_hash, Ledger.source_url
- Trigger: A document is fetched for hashing, on every scrape, every cycle

Many schools reuse the same 'no violations found as of [date]' template every cycle, changing only the embedded date. IF the raw fetched text were hashed as-is, THEN the hash would register as 'changed' every single cycle even though nothing substantive did — false-flagging most non-reporting schools every cycle and defeating the whole point of the Ledger (re-triggering AI extraction on unchanged boilerplate). Fix: strip recognizable date/reporting-period tokens (full dates, date ranges, bare years, phrases like 'this reporting period') from the fetched text BEFORE computing content_hash. Runs unconditionally on every fetched document, not just ones already known to reuse boilerplate. This is pipeline code — the specific list of tokens/patterns to strip is implementation detail that belongs in codebase, not this dictionary?


**NOT YET DECIDED: pre-filter gate before full AI extraction runs?**
- Tables/fields involved: Ledger, Artifacts, Staging_incidents
- Trigger: Ledger routes a URL to AI extraction (new or changed content)

Currently, every URL the Ledger routes to extraction (new or changed) triggers a full extraction call. NEEDED: a cheap pre-filter gate between 'Ledger says this changed' and 'run the expensive extraction call,' so extraction only runs on candidates that actually look like a CHTR. Mechanism undecided, options include a pure keyword/pattern match against the page title/URL/heading text (no AI cost), or a much cheaper classification-only AI call separated from the full extraction. Whichever mechanism is choosen, it will need real-world examples of how schools actually label these reports (page titles, headers, link text) — Lana's can compile that naming-variant list when needed, it is the same kind of work already done for the 'Example label variants' fields elsewhere in this dictionary.


**Artifact FKs set at creation, not deferred**
- Tables/fields involved: Artifacts.ledger_id, Artifacts.data_check_id, Artifacts.pipeline_run_id
- Trigger: A new Artifact row is created

Set ledger_id, data_check_id, and pipeline_run_id on the Artifact at the moment it's created — never deferred until incidents are found. An Artifact can legitimately yield zero incidents; if these links only get written when incidents exist, that Artifact becomes untraceable back to its school and its run.


**Retry: frozen vs. repointable pipeline_run_id**
- Tables/fields involved: Data_checks.pipeline_run_id, Artifacts.pipeline_run_id, Data_checks.pipeline_status
- Trigger: A Partial/Error Data_checks row is picked up again by a later pipeline run

Data_checks.pipeline_run_id updates to reflect the retry (it's a 'most recently touched by' pointer, since Data_checks is the same row updated in place, not recreated per attempt). Artifacts.pipeline_run_id, by contrast, is set once at Artifact creation and never changes — an Artifact created during the earlier failed run must keep pointing at that original run, not whatever run most recently retried its parent Data_check. Deriving an Artifact's run only through its parent Data_check would give the wrong answer after a retry; this is why both fields exist separately.


**Data Check created unconditionally, every school every cycle**
- Tables/fields involved: Data_checks (unitid, chtr_index_url, checked_by, data_check_date, created_at, pipeline_status)
- Trigger: A check cycle begins for a given school

Write a Data_checks row regardless of outcome — including when chtr_index_url is blank. A confirmed 'no CHTR exists' is not a separately stored value; it's inferred directly from chtr_index_url and Transparency Report both being blank, and needs no further correction mechanism if a URL is found later.


## Controlled vocabularies

### Academic term

New August 17, 2026 — CV for start_date_academic_term/end_date_academic_term (Incident_dates).

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Fall | Source names Fall (or a recognized synonym, "Autumn") as the term the occurrence's date falls within. | Store as "Fall" regardless of which synonym the source used. Only populated when the corresponding _precision field is Academic term. | start_date_academic_term, end_date_academic_term | Incident_dates |
| Spring | Source names Spring as the term the occurrence's date falls within. |  | start_date_academic_term, end_date_academic_term | Incident_dates |
| Summer | Source names Summer as the term the occurrence's date falls within. |  | start_date_academic_term, end_date_academic_term | Incident_dates |
| Winter | Source names Winter as the term the occurrence's date falls within. |  | start_date_academic_term, end_date_academic_term | Incident_dates |

### Alcohol involved

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Yes | The source unambiguously indicates alcohol use or intoxication (e.g. 'found intoxicated,' 'vomiting from drinking,' a stated blood alcohol level) — not merely adjacent context like 'party' or 'social event' without an explicit indication of actual use. |  | alcohol_involved | Staging_incidents, Incidents |
| No | Source explicitly states alcohol was not involved. |  | alcohol_involved | Staging_incidents, Incidents |
| Not specified | Alcohol was neither stated nor implied in the source — never inferred as No from silence. |  | alcohol_involved | Staging_incidents, Incidents |
| Unable to determine - Unclear reporting | New August 17, 2026. Source presents alcohol/drugs as one combined affirmative field, but neither the field itself nor any surrounding text names which substance(s) were involved — allocation genuinely fails, not just goes unattempted. | Set on both alcohol_involved and drugs_involved together, never just one. Distinct from "Not specified" (source never raised alcohol/drugs at all) and from a fabricated "Yes" (which would claim certainty the source doesn't support). | alcohol_involved | Staging_incidents, Incidents |

### Artifact format

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| HTML | Fetched artifact's Content-Type header indicated HTML. |  | artifact_format | Artifacts |
| Other | Fetched artifact's Content-Type header indicated a format other than HTML or PDF. |  | artifact_format | Artifacts |
| PDF | Fetched artifact's Content-Type header indicated PDF. |  | artifact_format | Artifacts |

### Date precision

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Year | Source gave only a calendar year. | Applies only when a bare calendar year is stated with no term, month, or day — e.g. '2024' with no other qualifying context. Do not use this for an academic-year span like '2024–2025' — that's Academic year. | start_date_precision, end_date_precision | Incident_dates |
| Day | Source gave a full calendar date. | No real boundary risk — applies whenever a full calendar date is stated, regardless of qualifier language (e.g. 'on or about 9/20/2025' is still Day). | start_date_precision, end_date_precision | Incident_dates |
| Academic year | Source gave a full academic-year span (e.g. 2024–2025), no specific term or date. | Applies only when a full academic-year span is stated (e.g. '2024–2025 academic year'), with no specific term or date named — including with qualifiers ('sometime during the 2024–2025 academic year' is still Academic year, not a vaguer category). Do not collapse into Year: an academic-year span (e.g. Sept–June) is distinct from a single calendar year. | start_date_precision, end_date_precision | Incident_dates |
| Academic term | Source gave a specific term (e.g. Fall 2025), no exact date. | Applies when a specific term name (Fall/Spring/Summer/Winter) and year are stated, but no exact date — including with qualifiers ('late Fall 2025' is still Academic term, not Academic year). Do not collapse into Academic year: a term is a subset of a year and is more specific. | start_date_precision, end_date_precision | Incident_dates |
| Month | Source gave a month and year, no specific day. | Applies when a month and year are stated but no day — including when a qualifier narrows within the month (e.g. 'early September 2025,' 'late September 2025'). The qualifier does not push this down to Day or up to a vaguer category; it's still Month. | start_date_precision, end_date_precision | Incident_dates |
| Unknown | Underlying raw date field is genuinely absent — cascades from the raw field's own missing-value flag; no separate flag written here. | Applies only when the underlying raw date field itself is genuinely absent (start_date_raw/end_date_raw = 'Not specified') — not a fallback for a raw date that's merely hard to parse. If a raw date exists but doesn't fit any precision level above, that's a modeling gap to flag for review, not an automatic Unknown. | start_date_precision, end_date_precision | Incident_dates |

### Determination status

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Pending | Investigation is still ongoing; no determination has been made yet. |  | determination_status, old_status, new_status | Staging_incidents, Incidents, Incident_status_history |
| Determined hazing | The institution formally determined the incident was hazing. |  | determination_status, old_status, new_status | Staging_incidents, Incidents, Incident_status_history |
| Dismissed | The institution's investigation concluded the incident did not constitute hazing / was dismissed. |  | determination_status, old_status, new_status | Staging_incidents, Incidents, Incident_status_history |
| Not specified | The source does not clearly state a determination outcome. |  | determination_status, old_status, new_status | Staging_incidents, Incidents, Incident_status_history |

### Drugs involved

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Yes | The source unambiguously indicates drug use (e.g. 'found unresponsive from drug use,' 'tested positive for [substance],' 'under the influence of drugs') — not merely adjacent context like 'party' or 'social event' without an explicit indication of actual use. |  | drugs_involved | Staging_incidents, Incidents |
| Not specified | Drugs were neither stated nor implied in the source — never inferred as No from silence. |  | drugs_involved | Staging_incidents, Incidents |
| No | Source explicitly states drugs were not involved. |  | drugs_involved | Staging_incidents, Incidents |
| Unable to determine - Unclear reporting | New August 17, 2026. See Alcohol involved's identical term above — set on both fields together when a combined-field affirmative can't be allocated to a specific substance. |  | drugs_involved | Staging_incidents, Incidents |

### Flag type

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Unable to determine organization type | The AI could not confidently assign an Organization Type controlled vocabulary term to a candidate organization from the source text — organization_type was left blank rather than guessed. Distinct from Legally required field missing, which covers SCHA-mandated incident fields (e.g. incident/investigation/notice date); this flag_type is specific to organization_type classification on Staging_organizations. |  | flag_type | Staging_incident_review_flags |
| Legally required field missing | A field the Stop Campus Hazing Act requires an institution to publish in its CHTR could not be found anywhere in the source. Records a compliance gap in the institution's report, not a failure of our extraction. | Renamed from 'Legally required field missing' (August 17, 2026) to make the statutory basis explicit and stop the term being reached for as a general-purpose 'value absent' flag. Reserved exclusively for the elements the Act names: the organization's name; a general description of the violation; whether the violation involved the abuse or illegal use of alcohol or drugs; the institution's findings; sanctions (as applicable — hence sanctions_raw flags only when determination_status is 'Determined hazing'); and the dates on which the incident was alleged to have occurred, the investigation was initiated, the investigation ended with a finding, and the institution provided notice to the organization. Never use for a field the Act does not name — an incident END date, a normalized or derived value, and an organization_type classification are all our own modeling, not an institutional obligation. | flag_type | Staging_incident_review_flags |
| Unable to derive value | A pipeline-derived or normalized field could not be populated even though the source data it derives from is present. Records a limitation of our extraction step, not a disclosure failure by the institution. | Added August 17, 2026 alongside the rename above. Current use: organization_name_normalized, when the AI declines to commit to a normalized name because the strip is genuinely ambiguous (the modifier+type phrase may itself be the org's chosen self-identifying name rather than a descriptor) — organization_name_raw is present and the institution has complied, so 'Legally required field missing' would be actively wrong there. Because Staging_incident_review_flags.field_name already carries the specific column, this term is deliberately general rather than per-field, unlike 'Unable to determine organization type'. Deliberately NOT applied to any end_date_* field: an unstated incident end date is neither a statutory element nor a derivation failure, so it writes no flag at all. | flag_type | Staging_incident_review_flags |
| Determination unclear | determination_status could not be confidently resolved from the source. |  | flag_type | Staging_incident_review_flags |
| Low extraction confidence | AI's extraction_confidence score fell below the review threshold. |  | flag_type | Staging_incident_review_flags |
| Alcohol/drugs review needed | Triggered when the source presents alcohol and drug use as one combined/labeled field (e.g. 'Alcohol/drug use') and that field indicates an affirmative — not when alcohol_involved or drugs_involved individually resolve to Yes from separately-labeled source fields. A combined affirmative doesn't disambiguate whether alcohol, drugs, or both were actually involved, so it always requires human review, regardless of whether the AI successfully allocated the substance(s) from surrounding text. |  | flag_type | Staging_incident_review_flags |
| Unrecognized date term | A raw date used an academic-term/year name outside the fixed anchor list (Fall/Spring/Summer/Winter), so start_date_normalized/end_date_normalized couldn't apply the standard convention. |  | flag_type | Staging_incident_review_flags |

### Human review status – incidents

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Approved | Reviewer confirmed the record is accurate and ready for the public table. |  | human_review_status | Staging_incidents |
| Pending review | Record has not yet been reviewed by a human. |  | human_review_status | Staging_incidents |
| Rejected | Reviewer determined the record should not be promoted to the public table. |  | human_review_status | Staging_incidents |

### Human review status – organizations

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Proposed | New Organization record proposed automatically at extraction time, awaiting human confirmation. |  | human_review_status | Staging_organizations |
| Rejected | Reviewer determined the proposed organization was incorrect; kept as audit trail, not deleted. |  | human_review_status | Staging_organizations |
| Approved | Reviewer confirmed the proposed organization is real and correctly identified. |  | human_review_status | Staging_organizations |

### Institutional recognition status

New August 17, 2026 — CV for institutional_recognition_status (Staging_incidents, Incidents). Deliberately per-incident, not per-organization.

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Recognized | The organization was institutionally recognized at the time of this specific incident. | Default when the source doesn't address recognition at all — CHTR-reported organizations are presumed recognized absent explicit evidence otherwise. No flag is written for this default. | institutional_recognition_status | Staging_incidents, Incidents |
| Unrecognized-Underground | The source explicitly states the organization was not recognized by or affiliated with the institution at the time of this incident. | Retires the old organization_type value "Unrecognized Organization" — this is now tracked here, independently of organizational category, and per-incident rather than as a fixed organization-level trait. | institutional_recognition_status | Staging_incidents, Incidents |
| Formerly Recognized - Lost Recognition | The organization had previously been recognized but lost that status before this incident occurred. | Do not code this if recognition was revoked *as a consequence of* the incident being coded — at the moment that incident occurred, the org was still Recognized; this value is only for incidents that occurred after a recognition loss already took effect. | institutional_recognition_status | Staging_incidents, Incidents |
| Unknown-Not Stated | Recognition status genuinely can't be determined from the source. |  | institutional_recognition_status | Staging_incidents, Incidents |

### Match basis

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Duplicate match | The staging-schema candidate incident record matched an already-published (public schema) incident record via the pipeline's key-matching logic, and the candidate's determination_status agrees with the existing public record's current status. Shown to the reviewer for visibility/audit purposes only — covers both a true re-extraction of unchanged content and the coincidental same-date-different-incident case — never acted on automatically since nothing has actually changed. |  | match_basis | Staging_incident_possible_matches |
| Status update to existing incident | The staging-schema candidate incident record matched an already-published (public schema) incident record via the pipeline's key-matching logic, but the candidate's determination_status differs from the existing public record's current status — the incident's outcome has actually changed (e.g. Pending resolving to a determination, or an already-resolved incident being corrected/revised on appeal). Triggers an in-place update to the public Incidents row plus an Incident_status_history entry upon reviewer approval, rather than inserting a new public row. |  | match_basis | Staging_incident_possible_matches |

### Match type

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| New proposal | No match was found in the public Organizations table — this is a genuinely new organization name, proposed for review and pending human confirmation via human_review_status. |  | match_type | Staging_organizations |
| Matched existing | The staging-schema candidate organization record's organization_name matched an existing record in the public Organizations table. |  | match_type | Staging_organizations |

### Membership gender composition

New August 17, 2026 — CV for membership_gender_composition (Organizations, Staging_organizations).

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| All-male | The organization's self-identified membership eligibility is exclusively male. | Identity-based, not sex-assigned-at-birth — a single-gender org with transgender members consistent with its stated identity stays single-gender. | membership_gender_composition | Organizations, Staging_organizations |
| All-female | The organization's self-identified membership eligibility is exclusively female. | "Sorority" is a reliable single-gender signal — a historically women's org that opens to men typically rebrands away from the label entirely rather than keeping it while admitting men. | membership_gender_composition | Organizations, Staging_organizations |
| Mixed-Co-ed | The organization's stated membership eligibility spans more than one gender identity. | Do not infer from "fraternity" in a name alone — many professional/business fraternities are explicitly co-ed. | membership_gender_composition | Organizations, Staging_organizations |
| Unknown-Not stated | Gender composition can't be determined from the source. | Default when the source doesn't clearly indicate composition — expected to be the common case, since CHTR text rarely states this explicitly. No flag written for this default. | membership_gender_composition | Organizations, Staging_organizations |

### Organization type

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Social fraternity or sorority | A Greek-lettered organization self-identifying as a social fraternity or sorority. | Replaces the old separate Fraternity/Sorority terms (August 17, 2026) — gender is now tracked independently via membership_gender_composition, not folded into organization_type. Checkable signal: self-identification as 'fraternity'/'sorority' plus social (not primarily service/professional) purpose. Priority-order check #1 in the tiebreaker rule. | organization_type | Organizations, Staging_organizations |
| Service or professional fraternity or sorority | A Greek-lettered organization organized primarily around a service mission or professional/academic discipline rather than general social purpose (e.g. a business or nursing fraternity/sorority). | Split out from Social fraternity or sorority (August 17, 2026) by purpose, not by gender. Checkable signal: explicit service or professional/discipline framing alongside Greek self-identification. | organization_type | Organizations, Staging_organizations |
| Varsity athletic team | A team, squad, or program formally administered by the institution's athletics department. | Renamed from Institution Athletic Team (August 17, 2026), same underlying definition — defined by institutional oversight, not NCAA-sanctioned status. See sports check (#10) in the tiebreaker rule for the three-way split against Club sport/Intramural. | organization_type | Organizations, Staging_organizations |
| Club sport | A student-organized sports team competing externally against other institutions, administered by a recreational sports/campus rec/student life office rather than athletics. | Distinguished from Varsity athletic team by administering office, not competitive level. Distinguished from Intramural or recreation sports team (new, August 17, 2026) by external competition — a Club sport team plays other schools; an Intramural team plays only within the institution. | organization_type | Organizations, Staging_organizations |
| Intramural or recreation sports team | A student sports team or program administered by Campus Rec, competing only in-house (not against other institutions). | New term (August 17, 2026) — previously conflated with Club Sport under the old vocabulary. See sports check (#10) in the tiebreaker rule. | organization_type | Organizations, Staging_organizations |
| Honor society | A student-run society organized around leadership development, recognition, or philanthropic/service involvement rather than a shared academic major, sport, or performance activity, with merit-based (not open/rush) induction. | Renamed from Honor/Leadership Society (August 17, 2026). Checkable signal: 'leadership,' 'honor,' 'selective/limited membership' language, merit-based induction distinguishing it from Social fraternity or sorority. | organization_type | Organizations, Staging_organizations |
| Academic club | A student organization organized around a shared academic discipline, career field, or professional interest, distinct from Greek-letter organizations and athletic teams. | Renamed from Academic/Professional Club (August 17, 2026). An org tied to both a discipline and a leadership/selectivity mission defaults to Honor society instead. | organization_type | Organizations, Staging_organizations |
| Performing arts organization | An independently organized performance group (theater, dance, a cappella/music, improv, comedy, film-making), or a color guard/drill/dance group unaffiliated with any band. | Renamed from Performing/Spirit Group (August 17, 2026), narrowed to exclude marching-band-affiliated units — see Marching band below. A CHTR incident rarely states organizational affiliation explicitly; when it isn't stated, use the org's own name/self-description rather than guessing (tiebreaker check #3, trimmed August 17, 2026 for this reason). | organization_type | Organizations, Staging_organizations |
| Marching band | A marching band program, including any color guard/drill/dance sub-units organized as part of it when the source states that affiliation. | Split out from Performing/Spirit Group (August 17, 2026). See Performing arts organization above for the affiliation-uncertainty handling. | organization_type | Organizations, Staging_organizations |
| ROTC or other military organization | A student organization with a military or quasi-military organizational model (e.g., Corps of Cadets units, ROTC-affiliated groups). | Renamed from Military/Cadet Organization (August 17, 2026), same underlying definition. Checkable signal is explicit Corps/ROTC/military-unit naming, including bare alphanumeric unit designations with no descriptive text (e.g. 'A-1,' 'K-2,' 'Squadron 17,' 'C-Battery') — treat these as valid names, not unclassifiable (tiebreaker check #2). | organization_type | Organizations, Staging_organizations |
| Social club | A student organization organized around a shared hobby or general social purpose, with no more specific category match. | Renamed from General Interest/Social Club (August 17, 2026). Catch-all, used only after ruling out the more specific categories above it in the tiebreaker order (check #11). | organization_type | Organizations, Staging_organizations |
| Faith-based organization | A student organization organized around a shared religious or faith-based identity or mission. | Renamed from Religious/Faith-Based Organization (August 17, 2026). An org whose primary stated function is welcoming/mentoring incoming students folds into Other type of organization instead, even under religious framing, per the retirement of the old Orientation/Mentorship Program category (tiebreaker check #5). | organization_type | Organizations, Staging_organizations |
| Culturally-based / identity-based organization | A student organization organized around a shared cultural, ethnic, or identity-based affiliation, not itself Greek-lettered. | New term (August 17, 2026). Defers to Greek self-identification (check #1) if the org is also Greek-lettered — a culturally-based Greek organization (e.g. an NPHC or multicultural fraternity/sorority) is still Social/Service fraternity or sorority first. | organization_type | Organizations, Staging_organizations |
| Student government or other student leadership organization | An organization with elected or appointed representative authority over a defined student body or subset (e.g. Student Government, Senate). | Renamed and narrowed from the governance-authority half of the old tiebreaker logic (August 17, 2026). A CHTR incident rarely states an org's actual governing authority, so this leans on explicit representative-body naming rather than inferred governance structure (tiebreaker check #6, trimmed for this reason). | organization_type | Organizations, Staging_organizations |
| Community service organization | A non-Greek student organization organized primarily around community service. | New term (August 17, 2026) — previously had no clean home in the 12-term vocabulary. Distinguished from Service or professional fraternity or sorority by not being Greek-lettered. | organization_type | Organizations, Staging_organizations |
| Political organization or social action group | A student organization organized around a political party, ideology, or single-cause advocacy focus. | New term (August 17, 2026). Distinguished from Campus media organization by focus — a media outlet with partisan/opinion content is still Campus media organization; an org that exists to serve one campaign or organizing agenda is this category instead (tiebreaker check #7, trimmed since publication history/ongoing status is rarely stated). | organization_type | Organizations, Staging_organizations |
| Campus media organization | A campus media outlet (newspaper, magazine, radio, TV, podcast, digital outlet). | New term (August 17, 2026) — previously had no home in the 12-term vocabulary. See Political organization or social action group above for the distinction. | organization_type | Organizations, Staging_organizations |
| Other type of organization | Final residual category after ruling out every other term, including what the old Orientation/Mentorship Program and Unrecognized Organization categories used to cover. | Renamed from a narrower 'General Interest/Social Club is the catch-all' framing (August 17, 2026). Orientation/Mentorship Program folded in here entirely. Unrecognized Organization is retired as an organization_type value — recognition status is now tracked independently and per-incident via institutional_recognition_status, not conflated with organization type. | organization_type | Organizations, Staging_organizations |


### Pipeline status

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Awaiting processing | Pipeline has not yet processed this Data Check record. |  | pipeline_status | Data_checks |
| Partial/Error | Processing started but did not complete cleanly. |  | pipeline_status | Data_checks |
| Complete | Pipeline has finished processing this Data Check record cleanly. |  | pipeline_status | Data_checks |

### Run status

| Term | Definition | Scope note | Field(s) | Table(s) |
|---|---|---|---|---|
| Running | Batch run is still in progress. |  | run_status | Pipeline-runs |
| Partial-Error | Batch run hit an error partway through. |  | run_status | Pipeline-runs |
| Complete | Batch run finished cleanly. |  | run_status | Pipeline-runs |

## Open questions / not yet decided

Pulled together from `Open questions and decisions` notes in the Data Dictionary and explicit "NOT YET DECIDED"/"OPEN" markers in Pipeline Logic, so they aren't buried in the tables above.

- **`Pipeline-runs.prompt_version`:** Confirm with Mahir how prompt versions are actually labeled/incremented (e.g., a version number, a date-stamp, a git commit hash) so the normalization rule can be documented precisely.
- **`Staging_organizations.organization_type`:** OPEN: How should a blank organization_type be surfaced to reviewers? Leaning toward reusing the existing Staging_Incident_Review_Flags 'Legally required field missing' flag_type pattern rather than a DB-level CHECK constraint (constraint approach was considered and rejected 7/17/26). Still needs: (1) decide whether flags for organizations live in the existing incident-scoped flags table (would need a nullable FK to Staging_organizations) or a new parallel Staging_Organization_Review_Flags table, and (2) decide whether an open flag should also block approval outright, or just be visible/informational on the review screen.
- **`Ledger.last_seen_date`:** Open question: should we track each individual "checked, unchanged" event, not just the current overwritten last_seen_date? Currently only actual content changes are preserved as history (via new Artifact rows); an unchanged check just bumps this field in place with nothing logged about the prior check-and-confirm events. Tracking every unchanged check too would let us report a "tokens saved by the ledger" stat (how many AI extraction calls were skipped), at the cost of a new write on every URL, every cycle. Decided against building this by default (mirrors the no_chtr_found/resolves_check_id call — current state over full history when nothing specific needs the history) — but worth reconsidering if that tokens-saved stat becomes something we actually want to report (e.g., for a funder or the maintenance guide).
- **`Ledger.fingerprint_content_hash`:** Confirm the hashing/normalization step is documented somewhere 
- **`Artifacts.artifact_location`:** Confirm exact key structure/naming convention with Mahir?
- **`Data_checks.data_check_date`:** This field is captured in Airtable as DD/MM/YY while our AI-extracted fields use YYYY-MM-DD — how is that inconsistency handled/reconciled in Neon?
- **`Staging_incidents.extraction_confidence`:** Threshold is provisional: starting at <0.7 triggers a flag. This is a starting point, not a settled standard — a self-reported LLM confidence score is not a true calibrated probability, so the real validation is checking the first batch of reviewed incidents: if low-scored incidents keep coming back clean, raise the threshold; if mid-range scores keep having real errors, lower it. Revisit after first review cycle. Currently exists in Mahir's extraction prompt (as of July 7, 2026) as a document-level score (one per CHTR page, in the same JSON object as is_chtr) — needs to move to per-incident, since a single CHTR can report multiple incidents and the review flag this drives (Staging_Incident_Review_Flags, flag_type = 'Low extraction confidence') is scoped per-incident, not per-document. 
- **Pipeline logic — NOT YET DECIDED: pre-filter gate before full AI extraction runs?:** Currently, every URL the Ledger routes to extraction (new or changed) triggers a full extraction call. NEEDED: a cheap pre-filter gate between 'Ledger says this changed' and 'run the expensive extraction call,' so extraction only runs on candidates that actually look like a CHTR. Mechanism undecided, options include a pure keyword/pattern match against the page title/URL/heading text (no AI cost), or a much cheaper classification-only AI call separated from the full extraction. Whichever mechanism is choosen, it will need real-world examples of how schools actually label these reports (page titles, headers, link text) — Lana's can compile that naming-variant list when needed, it is the same kind of work already done for the 'Example label variants' fields elsewhere in this dictionary.
