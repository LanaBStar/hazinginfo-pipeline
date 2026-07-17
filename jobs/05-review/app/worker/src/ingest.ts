/**
 * ingest.ts -- TypeScript port of jobs/05-review/ingest.py's ingest_review(). A
 * Cloudflare Worker can't run Python, so this is the review Worker's real write path;
 * jobs/05-review/ingest.py remains the settled source of truth (per its own docstring)
 * -- this file must reject/accept every case tests/test_phase7a_review.py exercises
 * identically, which is what test/ingest.test.ts checks.
 *
 * ingestReview(store, docDir, reviewJson) does exactly what ingest_review() does, in
 * order, never partially writing -- see jobs/05-review/ingest.py's docstring for the
 * full rationale of each step (hash-pinning invariant 9, re-anchoring on "corrected",
 * the null-incident_index / "escalated" additions from Phase 7b).
 */
import { anchorQuote } from "./quotes";
import { sha256Hex } from "./hashing";
import { validateReviewSchema, ReviewSchemaError } from "./reviewSchema";
import type { ArchiveStore } from "./store";
import { getText, putJson } from "./store";
import type { Incident, IncidentsJson, ReviewJson } from "./types";

export class IngestError extends Error {}

// Mirrors ingest.py's QUOTE_FIELDS / jobs/06-publish/rebuild.py's CORRECTION_FIELDS
// vocabulary for the four quote-bearing incident fields correctable through review.json.
const QUOTE_FIELDS: Record<string, [string, string]> = {
  organization_quote: ["organization_quote.text", "organization_quote.page"],
  description_quote: ["description_quote.text", "description_quote.page"],
  findings_quote: ["findings_quote.text", "findings_quote.page"],
  "dates.incident_quote": ["dates.incident_quote.text", "dates.incident_quote.page"],
};

function slugify(reviewer: string): string {
  const slug = reviewer
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "reviewer";
}

function filenameTs(reviewedAt: string): string {
  const d = new Date(reviewedAt);
  if (Number.isNaN(d.getTime())) throw new IngestError(`reviewed_at is not a valid date-time: ${reviewedAt}`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return null;
    return (node as Record<string, unknown>)[key];
  }, obj);
}

/** (resolved decision, merged corrections) after second_review's last-write-wins
 * override -- same rule jobs/06-publish/rebuild.py applies at read time. */
function resolvedDecision(review: ReviewJson): [string, Record<string, string>] {
  const corrections: Record<string, string> = { ...(review.corrections ?? {}) };
  let decision: string = review.decision;
  const second = review.second_review;
  if (second !== null) {
    decision = second.decision;
    Object.assign(corrections, second.corrections ?? {});
  }
  return [decision, corrections];
}

async function findIncidentsJson(store: ArchiveStore, docDir: string, fileHash: string): Promise<IncidentsJson> {
  const prefix = `${docDir}/ai/extract_v`;
  const keys = await store.listKeys(`${docDir}/ai/`);
  for (const key of keys) {
    if (!key.startsWith(prefix) || !key.endsWith("/incidents.json")) continue;
    const raw = await store.getBytes(key);
    if ((await sha256Hex(raw)) === fileHash) {
      return JSON.parse(new TextDecoder().decode(raw)) as IncidentsJson;
    }
  }
  throw new IngestError(
    `extraction_ref.file_hash ${fileHash} matches no incidents.json under ${docDir}/ai/ -- ` +
      "review does not pin to an extraction that exists in the archive"
  );
}

function reanchorCorrections(incident: Incident, corrections: Record<string, string>, documentText: string): void {
  for (const [fieldPath, [textKey, pageKey]] of Object.entries(QUOTE_FIELDS)) {
    if (!(textKey in corrections) && !(pageKey in corrections)) continue;
    const original = (getPath(incident as unknown as Record<string, unknown>, fieldPath) as
      | { text?: string; page?: number | null }
      | null) ?? {};
    const text = textKey in corrections ? corrections[textKey] : original.text;
    let page: number | null | undefined = pageKey in corrections ? undefined : original.page;
    if (pageKey in corrections) {
      const raw = corrections[pageKey];
      const parsed = Number(raw);
      if (raw === "" || Number.isNaN(parsed)) {
        throw new IngestError(`correction ${pageKey} must be an integer page number, got ${JSON.stringify(raw)}`);
      }
      page = parsed;
    }
    if (!text) {
      throw new IngestError(`correction touching ${fieldPath} targets a null/empty quote`);
    }
    const result = anchorQuote(text, page ?? null, documentText);
    if (!result.anchored) {
      throw new IngestError(
        `corrected ${fieldPath} ("${text.slice(0, 80)}") no longer anchors in the document's extracted text`
      );
    }
  }
}

export async function ingestReview(store: ArchiveStore, docDir: string, reviewJson: unknown): Promise<string> {
  try {
    validateReviewSchema(reviewJson);
  } catch (e) {
    if (e instanceof ReviewSchemaError) throw new IngestError(`schema validation failed: ${e.message}`);
    throw e;
  }
  const review = reviewJson as ReviewJson;

  const fileHash = review.extraction_ref.file_hash;
  const incidentIndex = review.extraction_ref.incident_index;

  const incidentsJson = await findIncidentsJson(store, docDir, fileHash);
  const incidents = incidentsJson.incidents ?? [];

  if (incidentIndex === null) {
    if (incidents.length > 0) {
      throw new IngestError(
        `extraction_ref.incident_index is null, but ${docDir} extraction has ${incidents.length} incident(s) -- ` +
          "null is reserved for zero-incident reports"
      );
    }
  } else if (incidentIndex >= incidents.length) {
    throw new IngestError(
      `extraction_ref.incident_index ${incidentIndex} out of range -- ` +
        `${docDir} extraction has ${incidents.length} incident(s)`
    );
  }

  const [decision, corrections] = resolvedDecision(review);
  if (decision === "corrected") {
    if (incidentIndex === null) {
      throw new IngestError(
        'a document-level (zero-incident) review cannot be "corrected" -- there is no per-field correction ' +
          "vocabulary for the document object; reject it instead to send the document back for re-extraction"
      );
    }
    const documentText = await getText(store, `${docDir}/extracted/text.txt`);
    reanchorCorrections(incidents[incidentIndex], corrections, documentText);
  }

  const indexToken = incidentIndex === null ? "document" : String(incidentIndex);
  const key = `${docDir}/reviews/${indexToken}_${slugify(review.reviewer)}_${filenameTs(review.reviewed_at)}.review.json`;
  await putJson(store, key, review);
  return key;
}

// Re-exported for queue.ts / index.ts, which need the same resolution rule to know
// whether an incident/document is still awaiting a decision.
export { resolvedDecision };
