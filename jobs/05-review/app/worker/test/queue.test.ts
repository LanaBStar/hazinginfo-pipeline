import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hashing";
import { buildQueue, loadReviewTarget } from "../src/queue";
import { MemoryStore, putJson } from "../src/store";
import type { IncidentDates, IncidentsJson, ValidationJson } from "../src/types";

// A minimal manifest -- only the fields queue.ts actually reads.
type ManifestFixture = { schema_version: 1; content_type: string; unitid: string; scrape_year: number } & Record<
  string,
  unknown
>;

const NR_DIR = "archive/200001_north-ridge-college/2026/docs/aaaa000000000000";
const HC_DIR = "archive/200006_hillcrest-academy/2026/docs/bbbb000000000000";
const EV_DIR = "archive/200002_eastview-university/2026/docs/cccc000000000000";

function dates(): IncidentDates {
  return {
    incident_start_raw: "",
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

function incident(confidence: number): IncidentsJson["incidents"][number] {
  return {
    organization_name_raw: "Org",
    organization_name_normalized: "org",
    organization_type: null,
    description_raw: "Description text.",
    findings_raw: null,
    sanctions_raw: null,
    alcohol_involved: "Not specified",
    drugs_involved: "Not specified",
    determination_status: "Pending",
    dates: dates(),
    extraction_confidence: confidence,
    flags: [],
  };
}

function incidentsWith(confidences: number[]): IncidentsJson {
  return {
    schema_version: 2,
    is_chtr: true,
    document: {
      reporting_period_start: null,
      reporting_period_end: null,
      publication_date: null,
      zero_incidents_statement: null,
    },
    incidents: confidences.map(incident),
  };
}

const ZERO_INCIDENTS: IncidentsJson = {
  schema_version: 2,
  is_chtr: true,
  document: {
    reporting_period_start: null,
    reporting_period_end: null,
    publication_date: null,
    zero_incidents_statement: "No hazing incidents were reported.",
  },
  incidents: [],
};

const VALID: ValidationJson = { schema_version: 2, valid: true, schema_errors: [] };

function manifest(unitid: string, contentType = "text/html"): ManifestFixture {
  return {
    schema_version: 1,
    source_url: "http://example.test/report",
    fetched_at: "2026-01-01T00:00:00Z",
    sha256: "0".repeat(64),
    content_type: contentType,
    size_bytes: 10,
    unitid,
    scrape_year: 2026,
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

async function seedDoc(docDir: string, unitid: string, incidents: IncidentsJson, contentType = "text/html") {
  await putJson(store, `${docDir}/manifest.json`, manifest(unitid, contentType));
  await putJson(store, `${docDir}/ai/extract_v1/incidents.json`, incidents);
  await putJson(store, `${docDir}/ai/extract_v1/validation.json`, VALID);
  store.seed(`${docDir}/extracted/text.txt`, "some extracted text");
}

describe("buildQueue", () => {
  it("orders by document, then by extraction_confidence ascending; a zero-incident target sorts first", async () => {
    await seedDoc(NR_DIR, "200001", incidentsWith([0.9, 0.4]));
    await seedDoc(HC_DIR, "200006", ZERO_INCIDENTS);

    const items = await buildQueue(store);
    const nrItems = items.filter((i) => i.docDir === NR_DIR);
    expect(nrItems.map((i) => i.extractionConfidence)).toEqual([0.4, 0.9]);
    expect(nrItems.map((i) => i.incidentIndex)).toEqual([1, 0]);

    const hcItem = items.find((i) => i.docDir === HC_DIR);
    expect(hcItem).toMatchObject({
      unitid: "200006",
      institutionSlug: "hillcrest-academy",
      incidentIndex: null,
      extractionConfidence: null,
    });
  });

  it("drops an item once it has any review -- decision is final, no escalation", async () => {
    await seedDoc(NR_DIR, "200001", incidentsWith([0.9]));
    const fileHash = await sha256Hex(await store.getBytes(`${NR_DIR}/ai/extract_v1/incidents.json`));

    let items = await buildQueue(store);
    expect(items).toHaveLength(1);

    await putJson(store, `${NR_DIR}/reviews/0_jane_20260101T000000Z.review.json`, {
      schema_version: 2,
      extraction_ref: { file_hash: fileHash, incident_index: 0 },
      decision: "approved",
      rejection_reason: null,
      corrections: [],
      organization_review: null,
      reviewer: "jane",
      reviewed_at: "2026-01-01T00:00:00Z",
    });
    items = await buildQueue(store);
    expect(items).toHaveLength(0);
  });

  it("skips a document whose validation.json is invalid", async () => {
    await seedDoc(EV_DIR, "200002", incidentsWith([0.5]), "application/pdf");
    await putJson(store, `${EV_DIR}/ai/extract_v1/validation.json`, {
      schema_version: 2,
      valid: false,
      schema_errors: ["boom"],
    });

    const items = await buildQueue(store);
    expect(items).toHaveLength(0);
  });
});

describe("loadReviewTarget", () => {
  it("returns the current extraction, validation, and null existingReview for an unreviewed item", async () => {
    await seedDoc(NR_DIR, "200001", incidentsWith([0.9]));
    const target = await loadReviewTarget(store, NR_DIR, 0);
    expect(target.existingReview).toBeNull();
    expect(target.incidentsJson.incidents).toHaveLength(1);
    expect(target.validation.valid).toBe(true);
  });
});
