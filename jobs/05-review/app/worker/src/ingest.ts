/**
 * ingest.ts -- TypeScript port of jobs/05-review/ingest.py's ingest_review(). A
 * Cloudflare Worker can't run Python, so this is the review Worker's real write path;
 * jobs/05-review/ingest.py remains the settled source of truth (per its own docstring)
 * -- this file must reject/accept every case tests/test_phase7a_review.py exercises
 * identically, which is what test/ingest.test.ts checks.
 *
 * v3.0: no more tier, escalation, second_review, or quote-anchoring on correction --
 * there's nothing left to anchor against once quotes themselves are gone. decision is a
 * single, final call. See jobs/05-review/ingest.py's docstring for the full rationale.
 */
import { sha256Hex } from "./hashing";
import { validateReviewSchema, ReviewSchemaError } from "./reviewSchema";
import type { ArchiveStore } from "./store";
import { putJson } from "./store";
import type { IncidentsJson, ReviewJson } from "./types";

export class IngestError extends Error {}

// Mirrors ingest.py's CORRECTABLE_FIELDS / jobs/06-publish/rebuild.py's own whitelist.
const CORRECTABLE_FIELDS = new Set([
  "organization_name_raw",
  "organization_name_normalized",
  "description_raw",
  "findings_raw",
  "sanctions_raw",
  "alcohol_involved",
  "drugs_involved",
  "determination_status",
  "dates.incident_start_raw",
  "dates.incident_start_normalized",
  "dates.incident_start_precision",
  "dates.incident_end_raw",
  "dates.incident_end_normalized",
  "dates.incident_end_precision",
  "dates.investigation_start_date_raw",
  "dates.investigation_start_date",
  "dates.investigation_end_date_raw",
  "dates.investigation_end_date",
  "dates.notice_date_raw",
  "dates.notice_date",
]);

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

function validateCorrections(corrections: ReviewJson["corrections"]): void {
  for (const correction of corrections) {
    if (!CORRECTABLE_FIELDS.has(correction.field_name)) {
      throw new IngestError(`correction targets unknown/uncorrectable field_name ${correction.field_name}`);
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

  if (review.decision === "corrected") {
    if (incidentIndex === null) {
      throw new IngestError(
        'a document-level (zero-incident) review cannot be "corrected" -- there is no per-field correction ' +
          "vocabulary for the document object; reject it instead to send the document back for re-extraction"
      );
    }
    validateCorrections(review.corrections);
  }

  if (review.organization_review !== null && incidentIndex === null) {
    throw new IngestError("a document-level (zero-incident) review has no organization to review");
  }

  const indexToken = incidentIndex === null ? "document" : String(incidentIndex);
  const key = `${docDir}/reviews/${indexToken}_${slugify(review.reviewer)}_${filenameTs(review.reviewed_at)}.review.json`;
  await putJson(store, key, review);
  return key;
}
