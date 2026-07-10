# 04-extract

## Purpose

Turn every archived, normalized document into structured incident data, per
IMPLEMENTATION_PLAN.md Section 8, and mechanically verify every factual claim before
it's archived (invariant 5). Classification (`is_chtr`) happens as part of extraction
-- there is no separate cleaning job. The agent never writes to the archive directly
(invariant 3): it fills in a packet, and only `validate.py` writes `incidents.json` /
`metadata.json` / `validation.json` into R2, after schema validation and anchoring.

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
   `incidents.json` into the packet directory, and fill in `metadata.json`'s `model`
   and `created` fields (leave `doc_dir`/`target_version` as-is -- `validate.py` reads
   and then strips them before archiving).
3. Run: `python jobs/04-extract/validate.py` (optionally `--tasks-dir PATH` to match
   step 1). For every packet whose `incidents.json` + finished `metadata.json` are
   present:
   - Strict JSON-schema validation of `incidents.json` against `schema.json` (unknown
     fields rejected). Archived either way -- invalid output is marked invalid, never
     discarded.
   - Every quote (and `document.zero_incidents_quote`) is anchored against
     `{doc_dir}/extracted/text.txt` via `lib/quotes.anchor_quote`.
   - Each incident (and, for a zero-incident report, the document itself) gets a tier
     per Section 9's table.
   - Archives `incidents.json` + a schema-compliant `metadata.json` + `validation.json`
     to `{doc_dir}/ai/extract_v{N}/`, where `doc_dir`/`N` come from the packet's
     `metadata.json` stub.

## Postconditions

- Every document that had `extracted/text.txt` and a finished packet now has an
  `ai/extract_v{N}/` directory with all three files, valid or not.
- `status.py`'s `extract.packets_done` reflects the run; a packet left without
  `incidents.json`/a finished `metadata.json` still counts as outstanding.

## Failure modes

- A single packet's validation/archival failure (corrupt `metadata.json`, missing
  `text.txt` in the archive, etc.) must not abort the whole run -- catch, log, and
  continue; that packet stays unresolved for the next run.
- Malformed or schema-invalid `incidents.json` is **not** a failure mode here -- it's
  archived with `valid: false` and its `schema_errors`, so a human can see exactly
  what the agent produced and why it didn't pass, rather than it vanishing silently.
- Cross-check disagreement has no wiring yet (see `crosscheck_prompt.md`'s header) --
  `crosscheck` is always `null`, so no incident reaches the `standard` tier from this
  job today; only `fast` (zero-incident reports) and `flagged` are reachable.
