-- catalog_schema.sql -- the six tables from IMPLEMENTATION_PLAN.md §12.
--
-- Applied by rebuild.py inside a freshly recreated `public` schema, every publish run
-- (invariant 2: rebuild is the only write path, no incremental import). Columns are
-- exactly those §12 names -- no invented fields. IDs on institutions/documents/
-- reports/incidents are content-derived hashes, never SERIAL (invariant 9); the two
-- child tables (incident_sanctions, reporting_status) have no independent identity of
-- their own in §12, so they carry no surrogate id column either -- just their FK plus
-- (for reporting_status) a natural composite key.

CREATE TABLE institutions (
    unitid text PRIMARY KEY,
    name   text NOT NULL,
    state  text
);

CREATE TABLE documents (
    content_hash    text PRIMARY KEY,
    unitid          text NOT NULL REFERENCES institutions(unitid),
    storage_key     text NOT NULL,
    source_url      text NOT NULL,
    fetched_at      timestamptz NOT NULL,
    scrape_year     integer NOT NULL,
    has_text_layer  boolean NOT NULL
);

CREATE INDEX documents_unitid_idx ON documents(unitid);

CREATE TABLE reports (
    report_id         text PRIMARY KEY,
    content_hash      text NOT NULL REFERENCES documents(content_hash),
    period_start      date,
    period_end        date,
    publication_date  date,
    is_zero_incident  boolean NOT NULL
);

CREATE INDEX reports_content_hash_idx ON reports(content_hash);

CREATE TABLE incidents (
    incident_id             text PRIMARY KEY,
    report_id               text NOT NULL REFERENCES reports(report_id),
    organization_text       text,
    organization_page       integer,
    description_text        text NOT NULL,
    description_page        integer,
    findings_text           text,
    findings_page           integer,
    alcohol_involved        boolean,
    drugs_involved          boolean,
    incident_date_text      text,
    incident_start          date,
    incident_end            date,
    investigation_initiated date,
    resolved                date,
    reviewer                text NOT NULL,
    reviewed_at             timestamptz NOT NULL,
    second_reviewer         text
);

CREATE INDEX incidents_report_id_idx ON incidents(report_id);

CREATE TABLE incident_sanctions (
    incident_id   text NOT NULL REFERENCES incidents(incident_id),
    sanction_text text NOT NULL,
    page          integer
);

CREATE INDEX incident_sanctions_incident_id_idx ON incident_sanctions(incident_id);

CREATE TABLE reporting_status (
    unitid      text NOT NULL REFERENCES institutions(unitid),
    scrape_year integer NOT NULL,
    status      text NOT NULL CHECK (status IN ('published', 'published_zero', 'not_found', 'no_url')),
    source_url  text,
    PRIMARY KEY (unitid, scrape_year)
);
