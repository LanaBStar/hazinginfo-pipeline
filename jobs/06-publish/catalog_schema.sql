-- catalog_schema.sql -- the 15 tables (2 schemas: staging / public), field-level
-- design from DATABASE_SCHEMA.md.
--
-- Applied by rebuild.py inside freshly recreated `staging`/`public` schemas, every
-- publish run (rebuild is the only write path, no incremental import). Table order
-- below is a topological sort of the FK graph (not the order DATABASE_SCHEMA.md lists
-- them in) -- staging.staging_incidents/staging_organizations have to exist before
-- public.incidents/incident_organizations can reference them, and public.incidents has
-- to exist before staging.staging_incident_possible_matches can reference it back.
--
-- ID strategy: every primary key is a content-derived text hash (short_hash of a
-- sha256), never SERIAL/IDENTITY -- rebuilds must be idempotent: identical archive ->
-- identical catalog, including every public ID. This overrides DATABASE_SCHEMA.md's own
-- field tables, which describe every PK as "Integer (PK, auto-generated)" -- that
-- description predates this catalog's move to content-derived IDs and is superseded by
-- it for ID typing. Institution.unitid is the one natural (non-hashed) key, per IPEDS.
--
-- Enums are TEXT + CHECK, matching the original catalog design's convention (no native
-- Postgres ENUM type), so the exact controlled-vocabulary term lists live in one place
-- (this file) and stay easy to diff against DATABASE_SCHEMA.md's own vocab tables.
--
-- Nullability corrections vs. DATABASE_SCHEMA.md's literal field tables:
--   - Institution.state_territory: DATABASE_SCHEMA.md says NOT NULL, but
--     sources/schools.csv's `state` column is blank for every row (no IPEDS state
--     backfill has happened yet). Left nullable so rebuild.py can actually populate
--     this table from the real schools.csv.
--   - Staging_organizations.organization_type: DATABASE_SCHEMA.md's field table says
--     NOT NULL, but its own scope note instructs leaving it NULL when the AI can't
--     confidently classify (never a placeholder value) -- and jobs/04-extract/schema.json
--     already treats organization_type as nullable for this exact reason. The field
--     table's contradiction is resolved in favor of the shipped, enforced extraction
--     schema.
--   - Staging_incidents.organization_name_raw/organization_name_normalized and
--     Staging_incident_corrections.original_value: same kind of conflict (DATABASE_SCHEMA.md
--     field tables say NOT NULL; the shipped jobs/04-extract/schema.json and
--     schemas/review.schema.json both allow null for these). Left nullable to match the
--     schemas actually enforced by validate.py/ingest.py.

CREATE SCHEMA staging;

-- ── public.institution ────────────────────────────────────────────────────────────────────────

CREATE TABLE public.institution (
    unitid          text PRIMARY KEY,
    institution     text NOT NULL,
    state_territory text,
    region          text,
    created_at      timestamptz NOT NULL
);

-- ── public.pipeline_runs ───────────────────────────────────────────────────────────────────

CREATE TABLE public.pipeline_runs (
    pipeline_run_id  text PRIMARY KEY,
    prompt_version   text NOT NULL,
    run_status       text NOT NULL CHECK (run_status IN ('Running', 'Complete', 'Partial-Error')),
    run_started_at   timestamptz NOT NULL,
    run_completed_at timestamptz
);

-- ── public.data_checks ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.data_checks (
    data_check_id   text PRIMARY KEY,
    unitid          text NOT NULL REFERENCES public.institution(unitid),
    pipeline_run_id text NOT NULL REFERENCES public.pipeline_runs(pipeline_run_id),
    chtr_index_url  text,
    checked_by      text NOT NULL,
    data_check_date date NOT NULL,
    pipeline_status text NOT NULL CHECK (pipeline_status IN ('Awaiting processing', 'Complete', 'Partial/Error')),
    created_at      timestamptz NOT NULL
);

CREATE INDEX data_checks_unitid_idx ON public.data_checks(unitid);
CREATE INDEX data_checks_pipeline_run_id_idx ON public.data_checks(pipeline_run_id);

-- ── public.ledger ───────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.ledger (
    ledger_id                text PRIMARY KEY,
    unitid                   text NOT NULL REFERENCES public.institution(unitid),
    source_url               text NOT NULL,
    first_seen_date          timestamptz NOT NULL,
    last_seen_date           timestamptz NOT NULL,
    fingerprint_content_hash text NOT NULL
);

CREATE INDEX ledger_unitid_idx ON public.ledger(unitid);

-- ── public.artifacts ───────────────────────────────────────────────────────────────────────

CREATE TABLE public.artifacts (
    artifact_id           text PRIMARY KEY,
    ledger_id             text NOT NULL REFERENCES public.ledger(ledger_id),
    data_check_id         text NOT NULL REFERENCES public.data_checks(data_check_id),
    pipeline_run_id       text NOT NULL REFERENCES public.pipeline_runs(pipeline_run_id),
    artifact_location     text NOT NULL,
    content_hash_snapshot text NOT NULL,
    artifact_format       text NOT NULL CHECK (artifact_format IN ('HTML', 'PDF', 'Other')),
    created_at            timestamptz NOT NULL
);

CREATE INDEX artifacts_ledger_id_idx ON public.artifacts(ledger_id);
CREATE INDEX artifacts_data_check_id_idx ON public.artifacts(data_check_id);
CREATE INDEX artifacts_pipeline_run_id_idx ON public.artifacts(pipeline_run_id);

-- ── staging.staging_incidents ────────────────────────────────────────────────────

CREATE TABLE staging.staging_incidents (
    staging_incident_id          text PRIMARY KEY,
    artifact_id                  text NOT NULL REFERENCES public.artifacts(artifact_id),
    institution_unitid           text NOT NULL REFERENCES public.institution(unitid),
    organization_name_raw        text,
    organization_name_normalized text,
    incident_description_raw     text,
    investigation_start_date_raw text,
    investigation_start_date     date,
    investigation_end_date_raw   text,
    investigation_end_date       date,
    notice_date_raw              text,
    notice_date                  date,
    sanctions_raw                text,
    findings_raw                 text,
    determination_status         text NOT NULL CHECK (determination_status IN ('Pending', 'Determined hazing', 'Dismissed', 'Not specified')),
    institutional_recognition_status text NOT NULL CHECK (institutional_recognition_status IN ('Recognized', 'Unrecognized/Underground', 'Formerly Recognized - Lost Recognition', 'Unknown/Not Stated')),
    alcohol_involved              text NOT NULL CHECK (alcohol_involved IN ('Yes', 'No', 'Not specified', 'Unable to determine - Unclear reporting')),
    drugs_involved                text NOT NULL CHECK (drugs_involved IN ('Yes', 'No', 'Not specified', 'Unable to determine - Unclear reporting')),
    extraction_confidence          numeric NOT NULL CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
    human_review_status            text NOT NULL DEFAULT 'Pending review' CHECK (human_review_status IN ('Pending review', 'Approved', 'Rejected')),
    reviewed_by                    text,
    reviewed_date                  timestamptz,
    reviewer_notes                 text,
    created_at                     timestamptz NOT NULL
);

CREATE INDEX staging_incidents_artifact_id_idx ON staging.staging_incidents(artifact_id);
CREATE INDEX staging_incidents_institution_unitid_idx ON staging.staging_incidents(institution_unitid);

-- ── staging.staging_organizations ───────────────────────────────────────────────

CREATE TABLE staging.staging_organizations (
    staging_organization_id text PRIMARY KEY,
    organization_name       text NOT NULL,
    organization_type       text CHECK (organization_type IN (
        'Social fraternity or sorority', 'Service or professional fraternity or sorority',
        'Varsity athletic team', 'Club sport', 'Intramural or recreation sports team',
        'Honor society', 'Academic club', 'Performing arts organization', 'Marching band',
        'ROTC or other military organization', 'Social club', 'Faith-based organization',
        'Culturally-based / identity-based organization',
        'Student government or other student leadership organization',
        'Community service organization', 'Political organization or social action group',
        'Campus media organization', 'Other type of organization'
    )),
    match_type          text NOT NULL CHECK (match_type IN ('New proposal', 'Matched existing')),
    membership_gender_composition text NOT NULL DEFAULT 'Unknown/Not stated' CHECK (membership_gender_composition IN ('All-male', 'All-female', 'Mixed/Co-ed', 'Unknown/Not stated')),
    human_review_status text NOT NULL DEFAULT 'Proposed' CHECK (human_review_status IN ('Proposed', 'Approved', 'Rejected')),
    reviewed_by         text,
    reviewed_date       timestamptz,
    reviewer_notes      text,
    created_at          timestamptz NOT NULL
);

-- ── public.organizations ────────────────────────────────────────────────────────────────

CREATE TABLE public.organizations (
    organization_id   text PRIMARY KEY,
    organization_name text NOT NULL,
    organization_type text NOT NULL CHECK (organization_type IN (
        'Social fraternity or sorority', 'Service or professional fraternity or sorority',
        'Varsity athletic team', 'Club sport', 'Intramural or recreation sports team',
        'Honor society', 'Academic club', 'Performing arts organization', 'Marching band',
        'ROTC or other military organization', 'Social club', 'Faith-based organization',
        'Culturally-based / identity-based organization',
        'Student government or other student leadership organization',
        'Community service organization', 'Political organization or social action group',
        'Campus media organization', 'Other type of organization'
    )),
    membership_gender_composition text NOT NULL DEFAULT 'Unknown/Not stated' CHECK (membership_gender_composition IN ('All-male', 'All-female', 'Mixed/Co-ed', 'Unknown/Not stated')),
    created_at timestamptz NOT NULL
);

-- ── public.incidents ──────────────────────────────────────────────────────────────────────

CREATE TABLE public.incidents (
    incident_id                   text PRIMARY KEY,
    institution_unitid            text NOT NULL REFERENCES public.institution(unitid),
    staging_incident_id            text NOT NULL REFERENCES staging.staging_incidents(staging_incident_id),
    incident_description_raw      text,
    investigation_start_date_raw  text,
    investigation_start_date      date,
    investigation_end_date_raw    text,
    investigation_end_date        date,
    notice_date_raw                text,
    notice_date                    date,
    sanctions_raw                  text,
    findings_raw                  text,
    determination_status           text NOT NULL CHECK (determination_status IN ('Pending', 'Determined hazing', 'Dismissed', 'Not specified')),
    institutional_recognition_status text NOT NULL CHECK (institutional_recognition_status IN ('Recognized', 'Unrecognized/Underground', 'Formerly Recognized - Lost Recognition', 'Unknown/Not Stated')),
    alcohol_involved                text NOT NULL CHECK (alcohol_involved IN ('Yes', 'No', 'Not specified', 'Unable to determine - Unclear reporting')),
    drugs_involved                  text NOT NULL CHECK (drugs_involved IN ('Yes', 'No', 'Not specified', 'Unable to determine - Unclear reporting')),
    updated_at                      timestamptz NOT NULL
);

CREATE INDEX incidents_institution_unitid_idx ON public.incidents(institution_unitid);
CREATE INDEX incidents_staging_incident_id_idx ON public.incidents(staging_incident_id);

-- ── public.incident_organizations ────────────────────────────────────────────────────

CREATE TABLE public.incident_organizations (
    incident_organization_id text PRIMARY KEY,
    staging_incident_id      text NOT NULL REFERENCES staging.staging_incidents(staging_incident_id),
    staging_organization_id  text NOT NULL REFERENCES staging.staging_organizations(staging_organization_id),
    incident_id              text REFERENCES public.incidents(incident_id),
    organization_id          text REFERENCES public.organizations(organization_id)
);

CREATE INDEX incident_organizations_staging_incident_id_idx ON public.incident_organizations(staging_incident_id);
CREATE INDEX incident_organizations_staging_organization_id_idx ON public.incident_organizations(staging_organization_id);
CREATE INDEX incident_organizations_incident_id_idx ON public.incident_organizations(incident_id);
CREATE INDEX incident_organizations_organization_id_idx ON public.incident_organizations(organization_id);

-- ── public.incident_dates ────────────────────────────────────────────────────────────────

CREATE TABLE public.incident_dates (
    incident_date_id      text PRIMARY KEY,
    staging_incident_id    text NOT NULL REFERENCES staging.staging_incidents(staging_incident_id),
    incident_id            text REFERENCES public.incidents(incident_id),
    start_date_raw          text,
    start_date_normalized  date,
    start_date_precision    text NOT NULL CHECK (start_date_precision IN ('Day', 'Month', 'Academic term', 'Academic year', 'Year', 'Unknown')),
    start_date_year         integer,
    start_date_month        integer CHECK (start_date_month BETWEEN 1 AND 12),
    start_date_academic_term text CHECK (start_date_academic_term IN ('Fall', 'Spring', 'Summer', 'Winter')),
    end_date_raw            text,
    end_date_normalized    date,
    end_date_precision      text NOT NULL CHECK (end_date_precision IN ('Day', 'Month', 'Academic term', 'Academic year', 'Year', 'Unknown')),
    end_date_year            integer,
    end_date_month           integer CHECK (end_date_month BETWEEN 1 AND 12),
    end_date_academic_term   text CHECK (end_date_academic_term IN ('Fall', 'Spring', 'Summer', 'Winter'))
);

CREATE INDEX incident_dates_staging_incident_id_idx ON public.incident_dates(staging_incident_id);
CREATE INDEX incident_dates_incident_id_idx ON public.incident_dates(incident_id);

-- ── public.incident_status_history ──────────────────────────────────────────────────────

CREATE TABLE public.incident_status_history (
    incident_status_history_id text PRIMARY KEY,
    incident_id                 text NOT NULL REFERENCES public.incidents(incident_id),
    staging_incident_id         text NOT NULL REFERENCES staging.staging_incidents(staging_incident_id),
    old_status                  text NOT NULL CHECK (old_status IN ('Pending', 'Determined hazing', 'Dismissed', 'Not specified')),
    new_status                  text NOT NULL CHECK (new_status IN ('Pending', 'Determined hazing', 'Dismissed', 'Not specified')),
    changed_at                  timestamptz NOT NULL
);

CREATE INDEX incident_status_history_incident_id_idx ON public.incident_status_history(incident_id);
CREATE INDEX incident_status_history_staging_incident_id_idx ON public.incident_status_history(staging_incident_id);

-- ── staging.staging_incident_possible_matches ───────────────────────────────────────────

CREATE TABLE staging.staging_incident_possible_matches (
    match_id              text PRIMARY KEY,
    candidate_incident_id text NOT NULL REFERENCES staging.staging_incidents(staging_incident_id),
    existing_incident_id  text NOT NULL REFERENCES public.incidents(incident_id),
    match_basis           text NOT NULL CHECK (match_basis IN ('Duplicate match', 'Status update to existing incident')),
    created_at             timestamptz NOT NULL
);

CREATE INDEX staging_incident_possible_matches_candidate_idx ON staging.staging_incident_possible_matches(candidate_incident_id);
CREATE INDEX staging_incident_possible_matches_existing_idx ON staging.staging_incident_possible_matches(existing_incident_id);

-- ── staging.staging_incident_review_flags ─────────────────────────────────────────────────
-- Exactly one of staging_incident_id / staging_organization_id is set per row (a flag
-- is about an incident or an organization proposal, never both/neither) -- enforced
-- here with a CHECK, strengthening DATABASE_SCHEMA.md's stated "pipeline-code-only"
-- enforcement rather than contradicting it (this schema is fully constrained
-- throughout, matching this file's usual convention).

CREATE TABLE staging.staging_incident_review_flags (
    flag_id                 text PRIMARY KEY,
    staging_incident_id     text REFERENCES staging.staging_incidents(staging_incident_id),
    staging_organization_id text REFERENCES staging.staging_organizations(staging_organization_id),
    flag_type               text NOT NULL CHECK (flag_type IN (
        'Legally required field missing', 'Unable to derive value',
        'Alcohol/drugs review needed', 'Determination unclear',
        'Low extraction confidence', 'Unrecognized date term', 'Unable to determine organization type'
    )),
    field_name  text NOT NULL,
    resolved_at timestamptz,
    created_at  timestamptz NOT NULL,
    CHECK (
        (staging_incident_id IS NOT NULL AND staging_organization_id IS NULL)
        OR (staging_incident_id IS NULL AND staging_organization_id IS NOT NULL)
    )
);

CREATE INDEX staging_incident_review_flags_incident_idx ON staging.staging_incident_review_flags(staging_incident_id);
CREATE INDEX staging_incident_review_flags_organization_idx ON staging.staging_incident_review_flags(staging_organization_id);

-- ── staging.staging_incident_corrections ───────────────────────────────────────────────────────

CREATE TABLE staging.staging_incident_corrections (
    staging_incident_correction_id text PRIMARY KEY,
    staging_incident_id             text NOT NULL REFERENCES staging.staging_incidents(staging_incident_id),
    field_name                      text NOT NULL,
    original_value                  text,
    corrected_value                 text NOT NULL,
    correction_type                 text[] NOT NULL CHECK (correction_type <@ ARRAY['Minor cleanup', 'Extraction error']),
    corrected_by                    text NOT NULL,
    corrected_at                    timestamptz NOT NULL
);

CREATE INDEX staging_incident_corrections_staging_incident_id_idx ON staging.staging_incident_corrections(staging_incident_id);
