import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hashing";
import { buildQueue, loadReviewTarget } from "../src/queue";
import { MemoryStore, putJson } from "../src/store";
import type { IncidentsJson, ValidationJson } from "../src/types";

// A minimal manifest -- only the fields queue.ts actually reads.
type ManifestFixture = { schema_version: 1; content_type: string; unitid: string; scrape_year: number } & Record<
  string,
  unknown
>;

const NR_DIR = "archive/200001_north-ridge-college/2026/docs/aaaa000000000000";
const HC_DIR = "archive/200006_hillcrest-academy/2026/docs/bbbb000000000000";
const EV_DIR = "archive/200002_eastview-university/2026/docs/cccc000000000000";

const EMPTY_INCIDENTS: IncidentsJson = {
  schema_version: 1,
  is_chtr: true,
  document: {
    title_quote: null,
    reporting_period_quote: null,
    reporting_period_start: null,
    reporting_period_end: null,
    publication_date: null,
    zero_incidents_quote: null,
  },
  incidents: [
    {
      organization_quote: { text: "Org", page: null },
      description_quote: { text: "Description text.", page: null },
      findings_quote: null,
      sanction_quotes: [],
      alcohol_involved: null,
      drugs_involved: null,
      dates: { incident_quote: null, incident_start: null, incident_end: null, investigation_initiated: null, resolved: null },
    },
  ],
};

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

function validationWith(tier: "standard" | "flagged"): ValidationJson {
  return {
    schema_version: 1,
    valid: true,
    schema_errors: [],
    document: { zero_incidents_quote: null, tier: null, flagged_reasons: [] },
    incidents: [
      {
        index: 0,
        tier,
        flagged_reasons: [],
        quotes: {
          organization_quote: null,
          description_quote: null,
          findings_quote: null,
          sanction_quotes: [],
          incident_quote: null,
        },
        crosscheck: null,
      },
    ],
  };
}

const FAST_VALIDATION: ValidationJson = {
  schema_version: 1,
  valid: true,
  schema_errors: [],
  document: { zero_incidents_quote: null, tier: "fast", flagged_reasons: [] },
  incidents: [],
};

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

async function seedDoc(docDir: string, unitidContentType: [string, string], incidents: IncidentsJson, validation: ValidationJson) {
  await putJson(store, `${docDir}/manifest.json`, manifest(...unitidContentType));
  await putJson(store, `${docDir}/ai/extract_v1/incidents.json`, incidents);
  await putJson(store, `${docDir}/ai/extract_v1/validation.json`, validation);
  store.seed(`${docDir}/extracted/text.txt`, "some extracted text");
}

describe("buildQueue", () => {
  it("orders items fast -> standard -> flagged, and derives institution name from doc_dir", async () => {
    await seedDoc(NR_DIR, ["200001", "text/html"], EMPTY_INCIDENTS, validationWith("flagged"));
    await seedDoc(EV_DIR, ["200002", "application/pdf"], EMPTY_INCIDENTS, validationWith("standard"));
    await seedDoc(HC_DIR, ["200006", "text/html"], { ...EMPTY_INCIDENTS, incidents: [] }, FAST_VALIDATION);

    const items = await buildQueue(store);
    expect(items.map((i) => i.tier)).toEqual(["fast", "standard", "flagged"]);
    expect(items[0]).toMatchObject({ docDir: HC_DIR, unitid: "200006", institutionSlug: "hillcrest-academy", incidentIndex: null });
    expect(items[1]).toMatchObject({ docDir: EV_DIR, unitid: "200002", institutionSlug: "eastview-university" });
  });

  it("drops an item once it has a terminal review, but keeps an unresolved escalation", async () => {
    await seedDoc(NR_DIR, ["200001", "text/html"], EMPTY_INCIDENTS, validationWith("flagged"));
    const fileHash = await sha256Hex(await store.getBytes(`${NR_DIR}/ai/extract_v1/incidents.json`));

    let items = await buildQueue(store);
    expect(items).toHaveLength(1);

    await putJson(store, `${NR_DIR}/reviews/0_jane_20260101T000000Z.review.json`, {
      schema_version: 1,
      extraction_ref: { file_hash: fileHash, incident_index: 0 },
      tier: "flagged",
      decision: "approved",
      rejection_reason: null,
      corrections: null,
      reviewer: "jane",
      reviewed_at: "2026-01-01T00:00:00Z",
      second_review: null,
    });
    items = await buildQueue(store);
    expect(items).toHaveLength(0);
  });

  it("surfaces an unresolved 'escalated' review as escalated_pending, still in the queue", async () => {
    await seedDoc(NR_DIR, ["200001", "text/html"], EMPTY_INCIDENTS, validationWith("standard"));
    const fileHash = await sha256Hex(await store.getBytes(`${NR_DIR}/ai/extract_v1/incidents.json`));

    await putJson(store, `${NR_DIR}/reviews/0_jane_20260101T000000Z.review.json`, {
      schema_version: 1,
      extraction_ref: { file_hash: fileHash, incident_index: 0 },
      tier: "standard",
      decision: "escalated",
      rejection_reason: null,
      corrections: null,
      reviewer: "jane",
      reviewed_at: "2026-01-01T00:00:00Z",
      second_review: null,
    });

    const items = await buildQueue(store);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("escalated_pending");
  });

  it("drops an escalation once a second_review resolves it", async () => {
    await seedDoc(NR_DIR, ["200001", "text/html"], EMPTY_INCIDENTS, validationWith("standard"));
    const fileHash = await sha256Hex(await store.getBytes(`${NR_DIR}/ai/extract_v1/incidents.json`));

    await putJson(store, `${NR_DIR}/reviews/0_jane_20260101T000000Z.review.json`, {
      schema_version: 1,
      extraction_ref: { file_hash: fileHash, incident_index: 0 },
      tier: "standard",
      decision: "escalated",
      rejection_reason: null,
      corrections: null,
      reviewer: "jane",
      reviewed_at: "2026-01-01T00:00:00Z",
      second_review: {
        decision: "approved",
        rejection_reason: null,
        corrections: null,
        reviewer: "operator",
        reviewed_at: "2026-01-02T00:00:00Z",
      },
    });

    const items = await buildQueue(store);
    expect(items).toHaveLength(0);
  });
});

describe("loadReviewTarget", () => {
  it("returns the current extraction, validation, and null existingReview for an unreviewed item", async () => {
    await seedDoc(NR_DIR, ["200001", "text/html"], EMPTY_INCIDENTS, validationWith("flagged"));
    const target = await loadReviewTarget(store, NR_DIR, 0);
    expect(target.existingReview).toBeNull();
    expect(target.incidentsJson.incidents).toHaveLength(1);
    expect(target.validation.incidents[0].tier).toBe("flagged");
  });
});
