/**
 * Ports the same cases tests/test_phase7a_review.py exercises against ingest.py,
 * against this file's TypeScript port -- both must reject/accept identically. Adds
 * Phase 7b's new paths (document-level review, "escalated") on top.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hashing";
import { IngestError, ingestReview } from "../src/ingest";
import { MemoryStore, putJson } from "../src/store";
import type { IncidentsJson } from "../src/types";

const NR_DIR = "archive/200001_north-ridge-college/2026/docs/aaaa000000000000";
const HC_DIR = "archive/200006_hillcrest-academy/2026/docs/bbbb000000000000";

const NR_TEXT =
  "Campus Hazing Transparency Report\n" +
  "Sigma Alpha Fraternity: new members were required to perform physically demanding tasks late at night.\n" +
  "The organization was found responsible for hazing.\n" +
  "Sanction: probation through Fall 2026.\n" +
  "Women's Club Rowing: members required new members to consume alcohol at a team event.";

const HC_TEXT =
  "Campus Hazing Transparency Report\n" +
  "No hazing incidents were reported during this reporting period.";

const NR_INCIDENTS: IncidentsJson = {
  schema_version: 1,
  is_chtr: true,
  document: {
    title_quote: null,
    reporting_period_quote: null,
    reporting_period_start: "2025-01-01",
    reporting_period_end: "2025-12-31",
    publication_date: null,
    zero_incidents_quote: null,
  },
  incidents: [
    {
      organization_quote: { text: "Sigma Alpha Fraternity", page: null },
      description_quote: {
        text: "new members were required to perform physically demanding tasks late at night.",
        page: null,
      },
      findings_quote: { text: "The organization was found responsible for hazing.", page: null },
      sanction_quotes: [{ text: "Sanction: probation through Fall 2026.", page: null }],
      alcohol_involved: false,
      drugs_involved: false,
      dates: { incident_quote: null, incident_start: null, incident_end: null, investigation_initiated: null, resolved: null },
    },
  ],
};

const HC_INCIDENTS: IncidentsJson = {
  schema_version: 1,
  is_chtr: true,
  document: {
    title_quote: null,
    reporting_period_quote: null,
    reporting_period_start: "2025-01-01",
    reporting_period_end: "2025-12-31",
    publication_date: null,
    zero_incidents_quote: { text: "No hazing incidents were reported during this reporting period.", page: null },
  },
  incidents: [],
};

function baseReview(fileHash: string, incidentIndex: number | null, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    extraction_ref: { file_hash: fileHash, incident_index: incidentIndex },
    tier: "flagged",
    decision: "approved",
    rejection_reason: null,
    corrections: null,
    reviewer: "jane-reviewer",
    reviewed_at: "2026-02-10T18:00:00Z",
    second_review: null,
    ...overrides,
  };
}

let store: MemoryStore;
let nrHash: string;
let hcHash: string;

beforeEach(async () => {
  store = new MemoryStore();
  store.seed(`${NR_DIR}/extracted/text.txt`, NR_TEXT);
  store.seed(`${HC_DIR}/extracted/text.txt`, HC_TEXT);
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

  it("accepts a corrected review whose corrected quote still anchors", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "corrected",
      corrections: { "organization_quote.text": "Sigma Alpha Fraternity" },
    });
    const key = await ingestReview(store, NR_DIR, review);
    expect(await store.exists(key)).toBe(true);
  });

  it("rejects a corrected review whose corrected quote does not anchor", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "corrected",
      corrections: { "organization_quote.text": "This text does not appear anywhere in the document." },
    });
    await expect(ingestReview(store, NR_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  it("second_review overriding corrected -> approved skips re-anchoring the bad first correction", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "corrected",
      corrections: { "organization_quote.text": "garbage nowhere in the document" },
      second_review: {
        decision: "approved",
        rejection_reason: null,
        corrections: null,
        reviewer: "john-reviewer",
        reviewed_at: "2026-02-11T09:00:00Z",
      },
    });
    const key = await ingestReview(store, NR_DIR, review);
    expect(await store.exists(key)).toBe(true);
  });

  it("second_review's correction (not first's) is the one re-anchored, last-write-wins", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "corrected",
      corrections: { "organization_quote.text": "Sigma Alpha Fraternity" }, // valid alone
      second_review: {
        decision: "corrected",
        rejection_reason: null,
        corrections: { "organization_quote.text": "still nowhere in the document" }, // invalid, should win
        reviewer: "john-reviewer",
        reviewed_at: "2026-02-11T09:05:00Z",
      },
    });
    await expect(ingestReview(store, NR_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  // ── Phase 7b: document-level (zero-incident, "fast" tier) review ──
  it("accepts a document-level approved review (incident_index null) for a genuine zero-incident extraction", async () => {
    const review = baseReview(hcHash, null, { tier: "fast" });
    const key = await ingestReview(store, HC_DIR, review);
    expect(key).toBe(`${HC_DIR}/reviews/document_jane-reviewer_20260210T180000Z.review.json`);
  });

  it("rejects incident_index null when the extraction actually has incidents", async () => {
    await expect(ingestReview(store, NR_DIR, baseReview(nrHash, null, { tier: "fast" }))).rejects.toBeInstanceOf(
      IngestError
    );
  });

  it("rejects a document-level review resolving to 'corrected'", async () => {
    const review = baseReview(hcHash, null, { tier: "fast", decision: "corrected", corrections: { "x": "y" } });
    await expect(ingestReview(store, HC_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });

  // ── Phase 7b: "escalated" decision ──
  it("accepts an escalated review with no corrections/re-anchoring required", async () => {
    const review = baseReview(nrHash, 0, { decision: "escalated" });
    const key = await ingestReview(store, NR_DIR, review);
    expect(await store.exists(key)).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(await store.getBytes(key)))).toMatchObject({ decision: "escalated" });
  });

  it("a second_review resolving an escalation to corrected re-anchors that correction", async () => {
    const review = baseReview(nrHash, 0, {
      decision: "escalated",
      second_review: {
        decision: "corrected",
        rejection_reason: null,
        corrections: { "organization_quote.text": "nowhere in the document at all" },
        reviewer: "john-reviewer",
        reviewed_at: "2026-02-11T09:00:00Z",
      },
    });
    await expect(ingestReview(store, NR_DIR, review)).rejects.toBeInstanceOf(IngestError);
  });
});
