/**
 * Anchoring: TypeScript port of lib/quotes.py's anchor_quote(). Per
 * IMPLEMENTATION_PLAN.md invariant 5, Section 9. Whitespace is normalized before
 * matching; the ~95% similarity threshold and page-marker check are per Section 9.
 * Output shape matches schemas/validation.schema.json's anchor_result exactly, same
 * as the Python side.
 *
 * The fuzzy-match fallback ports Python's difflib.SequenceMatcher (Ratcliff/Obershelp,
 * autojunk=False -- our Python caller never passes autojunk=True) closely enough that
 * the two sides agree on every fixture case exercised by tests/test_phase7a_review.py
 * and this Worker's own test/quotes.test.ts.
 */

export const SIMILARITY_THRESHOLD = 0.95;

const WHITESPACE_RE = /\s+/g;
const PAGE_MARKER_RE = /\[\[page (\d+)\]\]/g;

export interface AnchorResult {
  anchored: boolean;
  similarity: number;
  offset: [number, number] | null;
  page_match: boolean | null;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(WHITESPACE_RE, " ").trim();
}

function pageAtOffset(offset: number, normalizedText: string): number | null {
  let page: number | null = null;
  PAGE_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAGE_MARKER_RE.exec(normalizedText)) !== null) {
    if (m.index > offset) break;
    page = parseInt(m[1], 10);
  }
  return page;
}

/** Port of difflib.SequenceMatcher's find_longest_match / get_matching_blocks / ratio,
 * restricted to what anchor_quote needs (no junk/autojunk heuristics, since the Python
 * caller always passes autojunk=False). */
class SequenceMatcher {
  private readonly a: string;
  private readonly b: string;
  private readonly b2j: Map<string, number[]>;

  constructor(a: string, b: string) {
    this.a = a;
    this.b = b;
    this.b2j = new Map();
    for (let i = 0; i < b.length; i++) {
      const ch = b[i];
      let indices = this.b2j.get(ch);
      if (!indices) {
        indices = [];
        this.b2j.set(ch, indices);
      }
      indices.push(i);
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices) {
        for (const j of indices) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Array<[number, number, number]> {
    const queue: Array<[number, number, number, number]> = [[0, this.a.length, 0, this.b.length]];
    const blocks: Array<[number, number, number]> = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k > 0) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return blocks;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, [, , size]) => sum + size, 0);
    const total = this.a.length + this.b.length;
    return total === 0 ? 1.0 : (2.0 * matches) / total;
  }
}

function bestFuzzyWindow(quote: string, text: string): [number, number, number] {
  const qlen = quote.length;
  if (!qlen || !text) return [0.0, 0, 0];

  const matcher = new SequenceMatcher(text, quote);
  let bestRatio = 0.0;
  let bestStart = 0;
  let bestEnd = Math.min(qlen, text.length);
  for (const [ai, bi, size] of matcher.getMatchingBlocks()) {
    if (size === 0) continue;
    const start = Math.max(0, ai - bi);
    const end = Math.min(text.length, start + qlen);
    const ratio = new SequenceMatcher(text.slice(start, end), quote).ratio();
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStart = start;
      bestEnd = end;
    }
  }
  return [bestRatio, bestStart, bestEnd];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function anchorQuote(quoteText: string, pageHint: number | null, documentText: string): AnchorResult {
  const normalizedText = normalizeWhitespace(documentText);
  const normalizedQuote = normalizeWhitespace(quoteText);

  if (!normalizedQuote || !normalizedText) {
    return { anchored: false, similarity: 0.0, offset: null, page_match: null };
  }

  const idx = normalizedText.indexOf(normalizedQuote);
  let similarity: number;
  let start: number;
  let end: number;
  if (idx !== -1) {
    similarity = 1.0;
    start = idx;
    end = idx + normalizedQuote.length;
  } else {
    [similarity, start, end] = bestFuzzyWindow(normalizedQuote, normalizedText);
  }

  const anchored = similarity >= SIMILARITY_THRESHOLD;
  if (!anchored) {
    return { anchored: false, similarity: round4(similarity), offset: null, page_match: null };
  }

  let pageMatch: boolean | null = null;
  if (pageHint !== null) {
    pageMatch = pageAtOffset(start, normalizedText) === pageHint;
  }

  return { anchored: true, similarity: round4(similarity), offset: [start, end], page_match: pageMatch };
}
