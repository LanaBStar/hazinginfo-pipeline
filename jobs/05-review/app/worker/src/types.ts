/** Shared shapes mirroring the archive's JSON schemas (schemas/*.schema.json,
 * jobs/04-extract/schema.json). Kept intentionally loose (no runtime validation here --
 * that's reviewSchema.ts for review.json, and the archive's writers are trusted to have
 * already validated everything else against its schema before archiving it). */

export interface Quote {
  text: string;
  page: number | null;
}

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

export interface IncidentDates {
  incident_quote: Quote | null;
  incident_start: string | null;
  incident_end: string | null;
  investigation_initiated: string | null;
  resolved: string | null;
}

export interface Incident {
  organization_quote: Quote | null;
  description_quote: Quote;
  findings_quote: Quote | null;
  sanction_quotes: Quote[];
  alcohol_involved: boolean | null;
  drugs_involved: boolean | null;
  dates: IncidentDates;
}

export interface IncidentsJson {
  schema_version: 1;
  is_chtr: boolean;
  document: {
    title_quote: Quote | null;
    reporting_period_quote: Quote | null;
    reporting_period_start: string | null;
    reporting_period_end: string | null;
    publication_date: string | null;
    zero_incidents_quote: Quote | null;
  };
  incidents: Incident[];
}

export interface AnchorResultJson {
  anchored: boolean;
  similarity: number;
  offset: [number, number] | null;
  page_match: boolean | null;
}

export interface ValidationJson {
  schema_version: 1;
  valid: boolean;
  schema_errors: string[];
  document: {
    zero_incidents_quote: AnchorResultJson | null;
    tier: "fast" | "flagged" | null;
    flagged_reasons: string[];
  };
  incidents: Array<{
    index: number;
    tier: "fast" | "standard" | "flagged";
    flagged_reasons: string[];
    quotes: {
      organization_quote: AnchorResultJson | null;
      description_quote: AnchorResultJson | null;
      findings_quote: AnchorResultJson | null;
      sanction_quotes: (AnchorResultJson | null)[];
      incident_quote: AnchorResultJson | null;
    };
    crosscheck: { agrees: boolean; notes: string } | null;
  }>;
}

export type Decision = "approved" | "rejected" | "corrected" | "escalated";
export type SecondDecision = "approved" | "rejected" | "corrected";
export type RejectionReason = "not_hazing" | "duplicate" | "segmentation_error" | "extraction_error" | null;

export interface SecondReview {
  decision: SecondDecision;
  rejection_reason: RejectionReason;
  corrections: Record<string, string> | null;
  reviewer: string;
  reviewed_at: string;
}

export interface ReviewJson {
  schema_version: 1;
  extraction_ref: { file_hash: string; incident_index: number | null };
  tier: "fast" | "standard" | "flagged";
  decision: Decision;
  rejection_reason: RejectionReason;
  corrections: Record<string, string> | null;
  reviewer: string;
  reviewed_at: string;
  second_review: SecondReview | null;
}
