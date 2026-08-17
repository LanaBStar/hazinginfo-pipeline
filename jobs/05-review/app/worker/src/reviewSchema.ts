/**
 * Hand-rolled validator for schemas/review.schema.json -- the Worker's bundle stays
 * dependency-free (no ajv) since this schema is small, fixed, and already fully
 * specified; keeping it hand-written also makes it trivial to keep in lockstep with
 * schemas/review.schema.json whenever that file changes.
 *
 * Mirrors jsonschema.Draft202012Validator(REVIEW_SCHEMA).validate() in ingest.py:
 * same required keys, same additionalProperties: false, same enums.
 *
 * v3.0: no more tier, escalated, or second_review -- decision is a single, final call.
 * corrections is now a list of per-field entries; organization_review is new.
 */

const DECISIONS = ["approved", "rejected", "corrected"] as const;
const ORG_DECISIONS = ["approved", "rejected", "corrected"] as const;
const REJECTION_REASONS = ["not_hazing", "duplicate", "segmentation_error", "extraction_error"] as const;
const CORRECTION_TYPES = ["Minor cleanup", "Extraction error"] as const;

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

const CORRECTION_ENTRY_REQUIRED = ["field_name", "original_value", "corrected_value", "correction_type"] as const;

function checkCorrections(value: unknown, where: string): void {
  if (!Array.isArray(value)) fail(`${where}.corrections must be an array`);
  value.forEach((entry, i) => {
    const w = `${where}.corrections[${i}]`;
    if (!isPlainObject(entry)) fail(`${w} must be an object`);
    checkAdditionalProperties(entry, CORRECTION_ENTRY_REQUIRED, w);
    checkRequired(entry, CORRECTION_ENTRY_REQUIRED, w);
    if (typeof entry.field_name !== "string") fail(`${w}.field_name must be a string`);
    if (entry.original_value !== null && typeof entry.original_value !== "string") {
      fail(`${w}.original_value must be a string or null`);
    }
    if (typeof entry.corrected_value !== "string") fail(`${w}.corrected_value must be a string`);
    if (!Array.isArray(entry.correction_type) || entry.correction_type.length < 1
        || !entry.correction_type.every((t: unknown) => (CORRECTION_TYPES as readonly string[]).includes(t as string))) {
      fail(`${w}.correction_type must be a non-empty array of ${CORRECTION_TYPES.join("/")}`);
    }
  });
}

const ORG_REVIEW_REQUIRED = ["decision", "corrected_organization_type", "corrected_membership_gender_composition"] as const;

function checkOrganizationReview(value: unknown, where: string): void {
  if (value === null) return;
  if (!isPlainObject(value)) fail(`${where}.organization_review must be an object or null`);
  checkAdditionalProperties(value, ORG_REVIEW_REQUIRED, `${where}.organization_review`);
  checkRequired(value, ORG_REVIEW_REQUIRED, `${where}.organization_review`);
  if (typeof value.decision !== "string" || !(ORG_DECISIONS as readonly string[]).includes(value.decision)) {
    fail(`organization_review.decision must be one of ${ORG_DECISIONS.join("/")}`);
  }
  if (value.corrected_organization_type !== null && typeof value.corrected_organization_type !== "string") {
    fail("organization_review.corrected_organization_type must be a string or null");
  }
  if (value.corrected_membership_gender_composition !== null && typeof value.corrected_membership_gender_composition !== "string") {
    fail("organization_review.corrected_membership_gender_composition must be a string or null");
  }
}

const TOP_LEVEL_REQUIRED = [
  "schema_version",
  "extraction_ref",
  "decision",
  "rejection_reason",
  "corrections",
  "organization_review",
  "reviewer",
  "reviewed_at",
] as const;

/** Throws ReviewSchemaError on any violation; returns void (not a type guard) since
 * callers re-wrap into IngestError with a consistent message prefix. */
export function validateReviewSchema(review: unknown): void {
  if (!isPlainObject(review)) fail("review_json must be an object");
  checkAdditionalProperties(review, TOP_LEVEL_REQUIRED, "review");
  checkRequired(review, TOP_LEVEL_REQUIRED, "review");

  if (review.schema_version !== 2) fail("schema_version must be 2");

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

  if (typeof review.decision !== "string" || !(DECISIONS as readonly string[]).includes(review.decision)) {
    fail(`decision must be one of ${DECISIONS.join("/")}`);
  }
  checkRejectionReason(review.rejection_reason, "review");
  checkCorrections(review.corrections, "review");
  checkOrganizationReview(review.organization_review, "review");
  if (typeof review.reviewer !== "string") fail("reviewer must be a string");
  checkDateTime(review.reviewed_at, "reviewed_at");
}
