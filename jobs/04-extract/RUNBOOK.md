# 04-extract

## Purpose

Turn every archived, normalized document into structured incident data. Classification
(`is_chtr`) happens as part of extraction -- there is no separate cleaning job. The agent
never writes to the archive directly: it fills in a packet, and only `validate.py` writes
`incidents.json` / `metadata.json` / `validation.json` into R2, after schema validation.

There is no quote-anchoring or tier assignment here (that mechanism, and `lib/quotes.py`
along with it, was retired). Instead, the agent reports its own per-incident
`extraction_confidence` and a structured `flags[]` array directly in `incidents.json`; a
human reviewer always makes the final call regardless of confidence. The old
`crosscheck_prompt.md` second-pass verification concept (tied to the now-removed
`standard` tier) was retired along with it.

## Preconditions

- At least one document has `extracted/text.txt` (i.e. 03-normalize has run).
- No write credentials are required from the agent -- `make_packets.py` and
  `validate.py` are plain Python; set `ARCHIVE_LOCAL_ROOT` for a local/fixtures run,
  or the `R2_*` env vars for a real run.

## Steps

1. Run: `python jobs/04-extract/make_packets.py` (optionally `--prefix smoke/` for the
   sandboxed smoke-run archive, `--tasks-dir PATH` for a non-default packet location).
   - For every document with `extracted/text.txt` but no existing
     `ai/extract_v*/incidents.json`, writes `tasks/extract/{unitid}_{hash16}/`
     containing `prompt.md`, `original.pdf`/`original.html`, `text.txt`,
     `schema.json`, and a `metadata.json` stub (`doc_dir`, `target_version`,
     `prompt_version` filled in; `model`/`created` left `null` for the agent).
   - Resumable: a document that already has any `ai/extract_v*/incidents.json` is
     skipped -- re-extraction under a new prompt is a deliberate future action, not
     something this scan triggers on its own.
2. For each packet under `tasks/extract/`: read `prompt.md`, follow it, write
   `incidents.json` into the packet directory (raw+normalized fields, organization
   proposal, `determination_status`, per-incident `extraction_confidence` and
   `flags[]` -- see `prompt.md` and `DATABASE_SCHEMA.md` for the full field rules),
   and fill in `metadata.json`'s `model` and `created` fields (leave
   `doc_dir`/`target_version` as-is -- `validate.py` reads and then strips them
   before archiving).
3. Run: `python jobs/04-extract/validate.py` (optionally `--tasks-dir PATH` to match
   step 1). For every packet whose `incidents.json` + finished `metadata.json` are
   present:
   - Strict JSON-schema validation of `incidents.json` against `schema.json` (unknown
     fields rejected). Archived either way -- invalid output is marked invalid, never
     discarded.
   - Archives `incidents.json` + a schema-compliant `metadata.json` + a `validation.json`
     that's now just `{schema_version, valid, schema_errors}` -- to
     `{doc_dir}/ai/extract_v{N}/`, where `doc_dir`/`N` come from the packet's
     `metadata.json` stub.

Organization matching (against the public `Organizations` registry) and cross-year
incident-status resolution are **not** this job's concern -- both are derived by
`06-publish/rebuild.py` at publish time, not computed or stored here.

## Postconditions

- Every document that had `extracted/text.txt` and a finished packet now has an
  `ai/extract_v{N}/` directory with all three files, valid or not.
- `status.py`'s `extract.packets_done` reflects the run; a packet left without
  `incidents.json`/a finished `metadata.json` still counts as outstanding.
  `extract.low_confidence` is informational only, not a routing signal.

## Failure modes

- A single packet's validation/archival failure (corrupt `metadata.json`, missing
  `text.txt` in the archive, etc.) must not abort the whole run -- catch, log, and
  continue; that packet stays unresolved for the next run.
- Malformed or schema-invalid `incidents.json` is **not** a failure mode here -- it's
  archived with `valid: false` and its `schema_errors`, so a human can see exactly
  what the agent produced and why it didn't pass, rather than it vanishing silently.
