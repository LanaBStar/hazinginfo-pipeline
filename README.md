# HazingInfo.org — CHTR Archival Pipeline

An archival and extraction pipeline for **Campus Hazing Transparency Report (CHTR)**
disclosures — the annual hazing-incident reports ~1,484 U.S. postsecondary institutions
are required to publish under the federal END ALL HAZING Act. The pipeline finds each
institution's report, permanently archives the original document, extracts structured
incident data with AI, routes every extraction through human review, and publishes the
approved results to a public Postgres catalog behind HazingInfo.org.

## Status

The full pipeline (discovery through publish) is built and covered by automated tests.
The core pipeline (R2, Neon, Airtable) has real credentials configured and can run
against production data; the review app is not live yet — it runs locally against a
simulated storage backend, since its Cloudflare Worker deploy (Access application,
narrowly-scoped R2 write credentials) hasn't happened. See
[CLAUDE.md](CLAUDE.md) for what's implemented vs. still open.

## How it works

```
sources/schools.csv (1,484 institutions, versioned in repo)
        │
  01-discover    agent finds each institution's CHTR URL → operator confirms → merged
        │        into schools.csv, cross-checked against an Airtable schools registry
  02-archive     crawls confirmed URLs, permanently stores original documents in R2
        │        (never mutated after write), records absence (no_url/not_found) too
  03-normalize   extracts plain text from every archived document (PDF/HTML/DOCX)
        │
  04-extract     AI reads the text and proposes structured incident data (raw +
        │        normalized fields, per-incident confidence, flags) — schema-validated,
        │        archived whether valid or not
  05-review      a human (via a web app) approves, corrects, or rejects each proposed
        │        incident and organization; every decision is written to R2 as an
        │        immutable, hash-pinned review.json
  06-publish     drops and fully rebuilds the Postgres catalog (staging + public
                 schemas) from the entire archive — Postgres holds no state of its own
```

R2 (object storage) is the **single source of truth** for everything the pipeline has
ever found or decided. Postgres is a disposable, fully-reproducible projection of it,
rebuilt from scratch on every publish run — never incrementally updated.

For the full architectural detail (archive layout, catalog schema, invariants,
conventions), see [CLAUDE.md](CLAUDE.md).

## Repo layout

```
sources/schools.csv     the tracked institution roster (versioned, hand/agent-edited via 01-discover)
jobs/01-discover/        find + confirm each institution's CHTR URL
jobs/02-archive/         crawl + permanently store original documents
jobs/03-normalize/       extract plain text from stored documents
jobs/04-extract/         AI extraction of structured incident data
jobs/05-review/          human review — ingest.py (Python) + app/ (Cloudflare Worker + Pages)
jobs/06-publish/         rebuild the Postgres catalog from the archive
lib/                     shared helpers (R2 access, hashing, fetch, text extraction, fingerprinting)
schemas/                 JSON Schemas for every artifact the pipeline writes
fixtures/                synthetic data for local development and the automated test suite
tests/                   pytest-style test suite (one file per job/phase)
reference/               frozen, read-only mirror of the predecessor repo (crawler source material)
status.py                derives full pipeline state by walking the archive — never cached
DATABASE_SCHEMA.md       authoritative field-by-field reference for the Postgres catalog
```

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill in real values; never commit .env
```

The pipeline's Python scripts work with no credentials at all if `ARCHIVE_LOCAL_ROOT` is
set to a local directory — every archive read/write goes there instead of R2. This is
how the fixtures and test suite run.

The review app (`jobs/05-review/app/`) additionally needs Node:

```bash
npm --prefix jobs/05-review/app/worker install
```

## Running it

```bash
.venv/bin/python status.py                      # current pipeline state, as JSON
.venv/bin/python jobs/01-discover/make_batches.py
.venv/bin/python jobs/02-archive/run.py
.venv/bin/python jobs/03-normalize/run.py
.venv/bin/python jobs/04-extract/make_packets.py
.venv/bin/python jobs/06-publish/rebuild.py
```

Each job directory has a `RUNBOOK.md` with its exact preconditions, steps, and failure
modes. To actually operate the pipeline session-to-session (via an AI agent working
through the menu `status.py` produces), see [OPERATIONS.md](OPERATIONS.md).

Run the review app locally:

```bash
npm --prefix jobs/05-review/app/worker run dev     # Worker API, localhost:8787
python3 -m http.server 8788 --directory jobs/05-review/app/pages   # static UI
```

## Testing

```bash
.venv/bin/python tests/test_phase0_schemas.py      # and every other tests/test_*.py
npm --prefix jobs/05-review/app/worker test         # review Worker unit tests
npm --prefix jobs/05-review/app/worker run typecheck
```

Tests build real (small) archives from `fixtures/` and run the actual pipeline scripts
against them — no mocked pipeline logic.

## Documentation map

- **[README.md](README.md)** (this file) — what the project is and how to get it running.
- **[CLAUDE.md](CLAUDE.md)** — architecture reference for anyone (human or agent) writing
  code in this repo: data flow, archive layout, catalog design, conventions.
- **[OPERATIONS.md](OPERATIONS.md)** — how to actually run the pipeline day-to-day via an
  agent acting as an operator console.
- **[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)** — field-by-field reference for the
  Postgres catalog.
