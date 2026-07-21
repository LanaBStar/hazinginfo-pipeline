/** Shared shapes mirroring the archive's JSON schemas (schemas/*.schema.json,
 * jobs/04-extract/schema.json). Kept intentionally loose (no runtime validation here --
 * that's reviewSchema.ts for review.json, and the archive's writers are trusted to have
 * already validated everything else against its schema before archiving it).
 *
 * v3.0: no more page-anchored Quote objects, tiers, or crosscheck -- every raw field is
 * verbatim text, every non-raw field is the AI's own interpretation, and each incident
 * carries its own extraction_confidence + flags[] instead. See IMPLEMENTATION_PLAN.md
 * §8/§9/§10. */

export interface Manifest {
  schema_version: 1;
  source_url: string;
  fetched_at: string;
  sha256: string;
  content_type: string;
  size_bytes: number;
  unitid: string;
  scrape_year: number;
}

export type AlcoholDrugs = "Yes" | "No" | "Not specified";
export type DeterminationStatus = "Pending" | "Determined hazing" | "Dismissed" | "Not specified";
export type DatePrecision = "Year" | "Day" | "Academic year" | "Academic term" | "Month" | "Unknown";
export type OrganizationType =
  | "Fraternity"
  | "Sorority"
  | "Institution Athletic Team"
  | "Club Sport"
  | "Honor/Leadership Society"
  | "Academic/Professional Club"
  | "Performing/Spirit Group"
  | "Military/Cadet Organization"
  | "General Interest/Social Club"
  | "Religious/Faith-Based Organization"
  | "Orientation/Mentorship Program"
  | "Unrecognized Organization"
  | null;
export type FlagType =
  | "Required field missing"
  | "Alcohol/drugs review needed"
  | "Determination unclear"
  | "Low extraction confidence"
  | "Unrecognized date term"
  | "Unable to determine organization type";

export interface Flag {
  flag_type: FlagType;
  field_name: string;
  note: string | null;
}

export interface IncidentDates {
  incident_start_raw: string;
  incident_start_normalized: string | null;
  incident_start_precision: DatePrecision;
  incident_end_raw: string;
  incident_end_normalized: string | null;
  incident_end_precision: DatePrecision;
  investigation_start_date_raw: string;
  investigation_start_date: string | null;
  investigation_end_date_raw: string;
  investigation_end_date: string | null;
  notice_date_raw: string;
  notice_date: string | null;
}

export interface Incident {
  organization_name_raw: string | null;
  organization_name_normalized: string | null;
  organization_type: OrganizationType;
  description_raw: string;
  findings_raw: string | null;
  sanctions_raw: string | null;
  alcohol_involved: AlcoholDrugs;
  drugs_involved: AlcoholDrugs;
  determination_status: DeterminationStatus;
  dates: IncidentDates;
  extraction_confidence: number;
  flags: Flag[];
}

export interface IncidentsJson {
  schema_version: 2;
  is_chtr: boolean;
  document: {
    reporting_period_start: string | null;
    reporting_period_end: string | null;
    publication_date: string | null;
    zero_incidents_statement: string | null;
  };
  incidents: Incident[];
}

export interface ValidationJson {
  schema_version: 2;
  valid: boolean;
  schema_errors: string[];
}

export type Decision = "approved" | "rejected" | "corrected";
export type RejectionReason = "not_hazing" | "duplicate" | "segmentation_error" | "extraction_error" | null;
export type OrgDecision = "approved" | "rejected" | "corrected";

export interface CorrectionEntry {
  field_name: string;
  original_value: string | null;
  corrected_value: string;
  correction_type: Array<"Minor cleanup" | "Extraction error">;
}

export interface OrganizationReview {
  decision: OrgDecision;
  corrected_organization_type: string | null;
}

export interface ReviewJson {
  schema_version: 2;
  extraction_ref: { file_hash: string; incident_index: number | null };
  decision: Decision;
  rejection_reason: RejectionReason;
  corrections: CorrectionEntry[];
  organization_review: OrganizationReview | null;
  reviewer: string;
  reviewed_at: string;
}
