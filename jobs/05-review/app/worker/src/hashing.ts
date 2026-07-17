/**
 * Content hashing. TypeScript port of lib/hashing.py -- must produce byte-identical
 * hex digests to the Python side, since extraction_ref.file_hash is computed by
 * validate.py (Python) and re-derived here to pin a review to an exact incidents.json.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
