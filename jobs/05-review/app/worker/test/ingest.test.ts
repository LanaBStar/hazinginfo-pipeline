/**
 * Ports the same cases tests/test_phase7a_review.py exercises against ingest.py,
 * against this file's TypeScript port -- both must reject/accept identically.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hashing";
import { IngestError, ingestReview } from "../src/ingest";
import { MemoryStore, putJson } from "../src/store";
import type { IncidentDates, IncidentsJson } from "../src/types";

const NR_DIR = "archive/200001_north-ridge-college/2026/docs/aaaa000000000000";
const HC_DIR = "archive/200006_hillcrest-academy/2026/docs/bbbb000000000000";

function dates(): IncidentDates {
  return {
    incident_start_raw: "late at night",
    incident_start_normalized: null,
    incident_start_precision: "Unknown",
    incident_end_raw: "",
    incident_end_normalized: null,
    incident_end_precision: "Unknown",
    investigation_start_date_raw: "",
    investigation_start_date: null,
    investigation_end_date_raw: "",
    investigation_end_date: null,
    notice_date_raw: "",
    notice_date: null,
  };
}

const NR_INCIDENTS: IncidentsJson = {
  schema_version: 2,
  is_chtr: true,
  document: {
    reporting_period_start: "2025-01-01",
    reporting_period_end: "2025-12-31",
    publication_date: null,
    zero_incidents_statement: null,
  },
  incidents: [
    {
      organization_name_raw: "Sigma Alpha Fraternity",
      organization_name_normalized: "sigma alpha fraternity",
      organization_type: "Fraternity",
      description_raw: "new members were required to perform physically demanding tasks late at night.",
      findings_raw: "The organization was found responsible for hazing.",
      sanctions_raw: "Sanction: probation through Fall 2026.",
      alcohol_involved: "No",
      drugs_involved: "No",
      determination_status: "Determined hazing",
      dates: dates(),
      extraction_confidence: 0.9,
      flags: [],
    },
  ],
};

const HC_INCIDENTS: IncidentsJson = {
  schema_version: 2,
  is_chtr: true,
  document: {
    reporting_period_start: "2025-01-01",
    reporting_period_end: "2025-12-31",
    publication_date: null,
    zero_incidents_statement: "No hazing incidents were reported during this reporting period.",
  },
  incidents: [],
};

function baseReview(fileHash: string, incidentIndex: number | null, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    extraction_ref: { file_hash: fileHash, incident_index: incidentIndex },
    decision: "approved",
    rejection_reason: null,
    corrections: [],
    organization_review: null,
    reviewer: "jane-reviewer",
    reviewed_at: "2026-02-10T18:00:00Z",
    ...overrides,
  };
}

let store: MemoryStore;
let nrHash: string;
let hcHash: string;

beforeEach(async () => {
  store = new MemoryStore();
  store.seed(`${NR_DIR}/extracted/text.txt`, "some text");
  store.seed(`${HC_DIR}/extracted/text.txt`, "some text");
  await putJson(store, `${NR_DIR}/ai/extract_v1/incidents.json`, NR_INCIDENTS);
  await putJson(store, `${HC_DIR}/ai/extract_v1/incidents.json`, HC_INCIDENTS);
  nrHash = await sha256Hex(await store.getBytes(`${NR_DIR}/ai/extract_v1/incidents.json`));
  hcHash = await sha256Hex(await store.getBytes(`${HC_DIR}/ai/extract_v1/incidents.json`));
});

describe("ingestReview", () => {
  it("writes a valid approved review to the expected key with byte-identical content", async () => {
    const review = baseReview(nrHash, 0, { reviewer: "Jane Doe <jane@x.edu>", reviewed_at: "2026-02-10T18:05:30Z" });
    const key = await ingestReview(store, NR_DIR, review);
    expect(key).toBe(`${NR_DIR}/reviews/0_jane-doe-jane-x-edu_20260210T180530Z.review.json`);
    expect(await store.exists(key)).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(await store.getBytes(key)))).toEqual(review);
  });

  it("rejects a file_hash matching no extraction under doc_dir, writes nothing", async () => {
    const before = await store.listKeys(`${NR_DIR}/reviews/`);
    await expect(ingestReview(store, NR_DIR, baseReview("0".repeat(64), 0))).rejects.toBeInstanceOf(IngestError);
    expect(await store.listKeys(`${NR_DIR}/reviews/`)).toEqual(before);
  });

  it("rejects an out-of-range incident_index", async () => {
    await expect(ingestReview(store, NR_DIR, baseReview(nrHash, 5))).rejects.toBeInstanceOf(IngestError);
  });

  it("rejects a bad decision enum value", async () => {
    await expect(ingestReview(store, NR_DIR, baseReview(nrHash, 0, { decision: "maybe" }))).rejects.toBeInstanceOf(
      IngestError
    );
  });

  it("rejects an unknown field (additionalProperties: false)", async () => {
    const review = baseReview(nrHash, 0, { not_a_real_field: "x" });
    await expect(ingestReview(store, NR_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  it("accepts a corrected review targeting a known correctable field", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "corrected",
      corrections: [
        {
          field_name: "organization_name_raw",
          original_value: "Sigma Alpha Fraternity",
          corrected_value: "Sigma Alpha Epsilon Fraternity",
          correction_type: ["Extraction error"],
        },
      ],
    });
    const key = await ingestReview(store, NR_DIR, review);
    expect(await store.exists(key)).toBe(true);
  });

  it("rejects a corrected review targeting an unknown field_name", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "corrected",
      corrections: [
        { field_name: "not_a_real_field", original_value: "x", corrected_value: "y", correction_type: ["Minor cleanup"] },
      ],
    });
    await expect(ingestReview(store, NR_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  it("accepts a document-level approved review (incident_index null) for a genuine zero-incident extraction", async () => {
    const review = baseReview(hcHash, null);
    const key = await ingestReview(store, HC_DIR, review);
    expect(key).toBe(`${HC_DIR}/reviews/document_jane-reviewer_20260210T180000Z.review.json`);
  });

  it("rejects incident_index null when the extraction actually has incidents", async () => {
    await expect(ingestReview(store, NR_DIR, baseReview(nrHash, null))).rejects.toBeInstanceOf(IngestError);
  });

  it("rejects a document-level review resolving to 'corrected'", async () => {
    const review = baseReview(hcHash, null, {
      decision: "corrected",
      corrections: [{ field_name: "description_raw", original_value: null, corrected_value: "x", correction_type: ["Minor cleanup"] }],
    });
    await expect(ingestReview(store, HC_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  it("rejects organization_review on a document-level review", async () => {
    const review = baseReview(hcHash, null, {
      organization_review: { decision: "approved", corrected_organization_type: null },
    });
    await expect(ingestReview(store, HC_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  it("accepts organization_review on a normal incident review", async () => {
    const review = baseReview(nrHash, 0, {
      organization_review: { decision: "corrected", corrected_organization_type: "Sorority" },
    });
    const key = await ingestReview(store, NR_DIR, review);
    const written = JSON.parse(new TextDecoder().decode(await store.getBytes(key)));
    expect(written.organization_review).toEqual({ decision: "corrected", corrected_organization_type: "Sorority" });
  });
});
