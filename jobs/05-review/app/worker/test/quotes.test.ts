import { describe, expect, it } from "vitest";
import { anchorQuote } from "../src/quotes";

const DOC =
  "Campus Hazing Transparency Report\n[[page 1]]\n" +
  "Zeta Psi Fraternity was investigated for hazing during Fall 2025 recruitment.\n" +
  "Sanction: suspension through Spring 2027.\n[[page 2]]\n" +
  "No further incidents were reported.";

describe("anchorQuote", () => {
  it("anchors an exact substring with similarity 1.0", () => {
    const result = anchorQuote("Zeta Psi Fraternity", 1, DOC);
    expect(result.anchored).toBe(true);
    expect(result.similarity).toBe(1.0);
    expect(result.page_match).toBe(true);
  });

  it("anchors across reflowed whitespace/newlines", () => {
    const result = anchorQuote("Zeta   Psi\nFraternity", null, DOC);
    expect(result.anchored).toBe(true);
    expect(result.similarity).toBe(1.0);
  });

  it("flags a wrong page hint even when the quote anchors", () => {
    const result = anchorQuote("Zeta Psi Fraternity", 2, DOC);
    expect(result.anchored).toBe(true);
    expect(result.page_match).toBe(false);
  });

  it("does not anchor an unrelated quote", () => {
    const result = anchorQuote("This text does not appear anywhere in the document.", null, DOC);
    expect(result.anchored).toBe(false);
    expect(result.offset).toBeNull();
    expect(result.page_match).toBeNull();
  });

  it("anchors a near-miss (single word swap) above the 95% threshold", () => {
    // "suspension" -> "suspention" (one-character typo) should still fuzzy-anchor.
    const result = anchorQuote("Sanction: suspention through Spring 2027.", 2, DOC);
    expect(result.anchored).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.95);
  });

  it("returns anchored:false, not a throw, for empty document text", () => {
    const result = anchorQuote("Zeta Psi Fraternity", null, "");
    expect(result.anchored).toBe(false);
    expect(result.similarity).toBe(0.0);
  });

  it("null page_hint never fails a page check", () => {
    const result = anchorQuote("No further incidents were reported.", null, DOC);
    expect(result.anchored).toBe(true);
    expect(result.page_match).toBeNull();
  });
});
