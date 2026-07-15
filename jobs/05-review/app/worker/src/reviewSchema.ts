/**
 * Hand-rolled validator for schemas/review.schema.json -- the Worker's bundle stays
 * dependency-free (no ajv) since this schema is small, fixed, and already fully
 * specified; keeping it hand-written also makes it trivial to keep in lockstep with
 * schemas/review.schema.json whenever that file changes (both were extended together
 * in Phase 7b: nullable extraction_ref.incident_index, "escalated" decision).
 *
 * Mirrors jsonschema.Draft202012Validator(REVIEW_SCHEMA).validate() in ingest.py:
 * same required keys, same additionalProperties: false, same enums.
 */

const DECISIONS = ["approved", "rejected", "corrected", "escalated"] as const;
const SECOND_REVIEW_DECISIONS = ["approved", "rejected", "corrected"] as const;
const REJECTION_REASONS = ["not_hazing", "duplicate", "segmentation_error", "extraction_error"] as const;
const TIERS = ["fast", "standard", "flagged"] as const;

export class ReviewSchemaError extends Error {}

function fail(msg: string): never {
  throw new ReviewSchemaError(msg);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkAdditionalProperties(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: additional property ${JSON.stringify(key)} is not allowed`);
  }
}

function checkRequired(obj: Record<string, unknown>, required: readonly string[], where: string): void {
  for (const key of required) {
    if (!(key in obj)) fail(`${where}: ${JSON.stringify(key)} is a required property`);
  }
}

function checkCorrections(value: unknown, where: string): void {
  if (value === null) return;
  if (!isPlainObject(value)) fail(`${where}.corrections must be an object or null`);
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") fail(`${where}.corrections[${JSON.stringify(k)}] must be a string`);
  }
}

function checkRejectionReason(value: unknown, where: string): void {
  if (value === null) return;
  if (typeof value !== "string" || !(REJECTION_REASONS as readonly string[]).includes(value)) {
    fail(`${where}.rejection_reason must be one of ${REJECTION_REASONS.join("/")} or null`);
  }
}

function checkDateTime(value: unknown, where: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`${where} must be an ISO 8601 date-time string`);
  }
}

const TOP_LEVEL_REQUIRED = [
  "schema_version",
  "extraction_ref",
  "tier",
  "decision",
  "rejection_reason",
  "corrections",
  "reviewer",
  "reviewed_at",
  "second_review",
] as const;

const SECOND_REVIEW_REQUIRED = ["decision", "rejection_reason", "corrections", "reviewer", "reviewed_at"] as const;

/** Throws ReviewSchemaError on any violation; returns void (not a type guard) since
 * callers re-wrap into IngestError with a consistent message prefix. */
export function validateReviewSchema(review: unknown): void {
  if (!isPlainObject(review)) fail("review_json must be an object");
  checkAdditionalProperties(review, TOP_LEVEL_REQUIRED, "review");
  checkRequired(review, TOP_LEVEL_REQUIRED, "review");

  if (review.schema_version !== 1) fail("schema_version must be 1");

  const ref = review.extraction_ref;
  if (!isPlainObject(ref)) fail("extraction_ref must be an object");
  checkAdditionalProperties(ref, ["file_hash", "incident_index"], "extraction_ref");
  checkRequired(ref, ["file_hash", "incident_index"], "extraction_ref");
  if (typeof ref.file_hash !== "string" || !/^[0-9a-f]{64}$/.test(ref.file_hash)) {
    fail("extraction_ref.file_hash must be a 64-character lowercase hex sha256 digest");
  }
  const idx = ref.incident_index;
  if (idx !== null && !(Number.isInteger(idx) && (idx as number) >= 0)) {
    fail("extraction_ref.incident_index must be a non-negative integer or null");
  }

  if (typeof review.tier !== "string" || !(TIERS as readonly string[]).includes(review.tier)) {
    fail(`tier must be one of ${TIERS.join("/")}`);
  }
  if (typeof review.decision !== "string" || !(DECISIONS as readonly string[]).includes(review.decision)) {
    fail(`decision must be one of ${DECISIONS.join("/")}`);
  }
  checkRejectionReason(review.rejection_reason, "review");
  checkCorrections(review.corrections, "review");
  if (typeof review.reviewer !== "string") fail("reviewer must be a string");
  checkDateTime(review.reviewed_at, "reviewed_at");

  if (review.second_review !== null) {
    const sr = review.second_review;
    if (!isPlainObject(sr)) fail("second_review must be an object or null");
    checkAdditionalProperties(sr, SECOND_REVIEW_REQUIRED, "second_review");
    checkRequired(sr, SECOND_REVIEW_REQUIRED, "second_review");
    if (typeof sr.decision !== "string" || !(SECOND_REVIEW_DECISIONS as readonly string[]).includes(sr.decision)) {
      fail(`second_review.decision must be one of ${SECOND_REVIEW_DECISIONS.join("/")}`);
    }
    checkRejectionReason(sr.rejection_reason, "second_review");
    checkCorrections(sr.corrections, "second_review");
    if (typeof sr.reviewer !== "string") fail("second_review.reviewer must be a string");
    checkDateTime(sr.reviewed_at, "second_review.reviewed_at");
  }
}
