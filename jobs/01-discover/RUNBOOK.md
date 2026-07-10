# 01-discover

## Purpose

Find each tracked institution's official CHTR URL and get it confirmed into
`sources/schools.csv`, without ever letting the agent write that file directly.
Per IMPLEMENTATION_PLAN.md §7 (01-discover) and invariant 3 (only validating scripts
write) / invariant 6 (human decisions are artifacts).

## Preconditions

- `sources/schools.csv` exists with at least one row whose `url_status` is blank (not
  yet searched, or a previously rejected candidate reset to blank).
- No write credentials are required from the agent — `make_batches.py` and `merge.py`
  are plain Python scripts; the agent only ever produces `candidates.json` inside a
  batch directory.

## Steps

1. **Batch:** `python jobs/01-discover/make_batches.py` — slices every school with a
   blank `url_status` into `tasks/discover/batch_{NNN}/` directories of ~25–50 schools
   each (`--batch-size` to override), each containing `prompt.md`, `schema.json`, and
   `schools_slice.csv`. Marks those rows `url_status=pending` in `schools.csv` so a
   second run never re-batches them.
2. **Search (agent):** for each unfinished batch directory, follow `prompt.md` and
   write `candidates.json` in that same directory, per `schema.json`.
3. **Confirm (operator, via console):** for each batch with a `candidates.json`, the
   agent presents every candidate (proposed URL, confidence, evidence quote) to the
   operator and asks confirm/reject for each. The agent writes the operator's answers
   to `tasks/discover/batch_{NNN}/decisions.json` (schema:
   `jobs/01-discover/decisions.schema.json`) — the chat exchange itself is not the
   decision; the file is. Every candidate in the batch must have a decision before
   `merge.py` will act on that batch.
4. **Merge:** `python jobs/01-discover/merge.py` — for every batch with a complete
   `decisions.json`, validates it against `candidates.json` (unitid exists, proposed
   URLs match, URL well-formed) and merges into `sources/schools.csv`: confirmed →
   `chtr_url`/`url_status=confirmed`/`evidence`; rejected → those three fields cleared
   back to blank, so the school is re-batched on the next pass. Marks the batch
   `merged.json` so it's never reprocessed, even if a rejected school later gets
   recycled into a new batch.

## Postconditions

- Every school that had a complete `decisions.json` this run has an updated
  `url_status` in `sources/schools.csv` — `confirmed` (with `chtr_url`/`evidence`
  filled in) or blank (rejected, eligible for re-batching).
- `sources/schools.csv` has exactly the same rows (by `unitid`) as before the run — no
  rows added or removed.
- `status.py`'s `discover.confirmed_urls` / `discover.pending_candidates` /
  `discover.no_url` counts reflect the merge.

## Failure modes

- A batch whose `decisions.json` is missing a decision for one of its candidates is
  left unmerged (not an error) — `merge.py` waits for the rest.
- A batch whose `decisions.json` references a `unitid` not in `schools.csv`, or whose
  `proposed_url` doesn't match the corresponding candidate's, or is malformed, fails
  validation for that batch only (logged) — it does not abort merging other ready
  batches, and `schools.csv` is not touched for a failed batch.
- `merge.py` never deletes or reorders rows; it asserts the row set is unchanged
  before writing `schools.csv` back.
