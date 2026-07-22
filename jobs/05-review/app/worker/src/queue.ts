/**
 * queue.ts -- builds the reviewable queue by walking the archive, the same way
 * status.py's walk_archive() derives pipeline state: never stored, always recomputed.
 * This is deliberately NOT read from Postgres: catalog_schema.sql's
 * `Incidents`/`Organizations` tables only ever contain *already-reviewed* (promoted)
 * rows (rebuild.py) -- there is no "pending" projection in Postgres to read a queue
 * from, so the archive itself (incidents.json's extraction_confidence + reviews/*
 * .review.json) is the only source of truth for "what still needs a human."
 * This also means the review app needs no Postgres/Neon credentials at all, only R2.
 *
 * There are no tiers or escalation. A review's decision is a single, final call --
 * once a matching review.json exists for (file_hash, incident_index), that target is
 * done and drops out of the queue entirely. Ordering is by document, then by
 * extraction_confidence ascending within a document (lowest-confidence items surfaced
 * first) -- a document-level (zero-incident) target has no confidence of its own and
 * sorts first.
 *
 * Institution display name comes from the doc_dir path's own `{unitid}_{slug}`
 * segment (e.g. "100001_alpha-college" -> slug "alpha-college") rather than a
 * schools.csv/Postgres lookup -- manifest.json carries no institution name, and
 * schools.csv isn't archived to R2, so the slug already baked into every doc_dir is
 * the only name available to a Worker that only holds R2 credentials.
 */
import { sha256Hex } from "./hashing";
import type { ArchiveStore } from "./store";
import { getJson } from "./store";
import type { IncidentsJson, Manifest, ReviewJson, ValidationJson } from "./types";

export interface QueueItem {
  docDir: string;
  unitid: string;
  institutionSlug: string;
  scrapeYear: number;
  contentType: string;
  incidentIndex: number | null;
  extractionConfidence: number | null;
  fileHash: string;
}

function docDirsFromKeys(keys: string[]): string[] {
  const dirs = new Set<string>();
  for (const key of keys) {
    const parts = key.split("/");
    if (parts.length >= 5 && parts[3] === "docs") {
      dirs.add(parts.slice(0, 5).join("/"));
    }
  }
  return [...dirs].sort();
}

function currentExtractVersion(keys: Set<string>, docDir: string): string | null {
  const prefix = `${docDir}/ai/extract_v`;
  let best: number | null = null;
  for (const key of keys) {
    if (key.startsWith(prefix) && key.endsWith("/incidents.json")) {
      const nStr = key.slice(prefix.length).split("/", 1)[0];
      const n = Number(nStr);
      if (Number.isInteger(n) && (best === null || n > best)) best = n;
    }
  }
  return best === null ? null : `extract_v${best}`;
}

export async function buildQueue(store: ArchiveStore, prefix = "archive/"): Promise<QueueItem[]> {
  const keys = await store.listKeys(prefix);
  const keySet = new Set(keys);
  const items: QueueItem[] = [];

  for (const docDir of docDirsFromKeys(keys)) {
    const manifestKey = `${docDir}/manifest.json`;
    if (!keySet.has(manifestKey)) continue;

    const version = currentExtractVersion(keySet, docDir);
    if (version === null) continue;
    const versionDir = `${docDir}/ai/${version}`;
    const incidentsKey = `${versionDir}/incidents.json`;
    const validationKey = `${versionDir}/validation.json`;
    if (!keySet.has(incidentsKey) || !keySet.has(validationKey)) continue;

    const incidentsBytes = await store.getBytes(incidentsKey);
    const validation = await getJson<ValidationJson>(store, validationKey);
    if (!validation.valid) continue;

    const fileHash = await sha256Hex(incidentsBytes);
    const manifest = await getJson<Manifest>(store, manifestKey);
    const incidentsJson = JSON.parse(new TextDecoder().decode(incidentsBytes)) as IncidentsJson;

    const reviewsPrefix = `${docDir}/reviews/`;
    const reviewKeys = keys.filter((k) => k.startsWith(reviewsPrefix));
    const reviews = await Promise.all(reviewKeys.map((k) => getJson<ReviewJson>(store, k)));

    const targets: Array<{ index: number | null; confidence: number | null }> = incidentsJson.incidents.map(
      (inc, i) => ({ index: i, confidence: inc.extraction_confidence })
    );
    if (incidentsJson.incidents.length === 0) targets.push({ index: null, confidence: null });

    const dirParts = docDir.split("/"); // ["archive", "{unitid}_{slug}", "{year}", "docs", "{hash16}"]
    const instDir = dirParts[1];
    const underscoreIdx = instDir.indexOf("_");
    const unitid = underscoreIdx === -1 ? instDir : instDir.slice(0, underscoreIdx);
    const institutionSlug = underscoreIdx === -1 ? instDir : instDir.slice(underscoreIdx + 1);
    const scrapeYear = Number(dirParts[2]);

    for (const target of targets) {
      const isReviewed = reviews.some(
        (r) => r.extraction_ref.file_hash === fileHash && r.extraction_ref.incident_index === target.index
      );
      if (isReviewed) continue; // decision is final -- out of the queue

      items.push({
        docDir,
        unitid,
        institutionSlug,
        scrapeYear,
        contentType: manifest.content_type,
        incidentIndex: target.index,
        extractionConfidence: target.confidence,
        fileHash,
      });
    }
  }

  items.sort((a, b) => {
    if (a.docDir !== b.docDir) return a.docDir < b.docDir ? -1 : 1;
    const ca = a.extractionConfidence ?? -Infinity;
    const cb = b.extractionConfidence ?? -Infinity;
    if (ca !== cb) return ca - cb;
    return (a.incidentIndex ?? -1) - (b.incidentIndex ?? -1);
  });

  return items;
}

/** Fetches everything one queue item's review screen needs: the current extraction,
 * its validation result, the manifest, and any existing review for this exact target
 * (present only if the queue was stale -- normally null, since a reviewed target
 * already dropped out of buildQueue's output). */
export async function loadReviewTarget(store: ArchiveStore, docDir: string, incidentIndex: number | null) {
  const keys = await store.listKeys(`${docDir}/`);
  const keySet = new Set(keys);
  const version = currentExtractVersion(keySet, docDir);
  if (version === null) throw new Error(`${docDir} has no extraction`);
  const versionDir = `${docDir}/ai/${version}`;

  const incidentsBytes = await store.getBytes(`${versionDir}/incidents.json`);
  const fileHash = await sha256Hex(incidentsBytes);
  const incidentsJson = JSON.parse(new TextDecoder().decode(incidentsBytes)) as IncidentsJson;
  const validation = await getJson<ValidationJson>(store, `${versionDir}/validation.json`);
  const manifest = await getJson<Manifest>(store, `${docDir}/manifest.json`);

  const textKey = `${docDir}/extracted/text.txt`;
  const extractedText = keySet.has(textKey) ? new TextDecoder().decode(await store.getBytes(textKey)) : "";

  const reviewsPrefix = `${docDir}/reviews/`;
  const reviewKeys = keys.filter((k) => k.startsWith(reviewsPrefix));
  const reviews = await Promise.all(reviewKeys.map((k) => getJson<ReviewJson>(store, k)));
  const existingReview =
    reviews
      .filter((r) => r.extraction_ref.file_hash === fileHash && r.extraction_ref.incident_index === incidentIndex)
      .sort((a, b) => (a.reviewed_at < b.reviewed_at ? 1 : -1))[0] ?? null;

  return { manifest, incidentsJson, validation, fileHash, extractedText, existingReview };
}
