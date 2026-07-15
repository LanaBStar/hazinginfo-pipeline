/**
 * ArchiveStore: the same seam lib/r2.py draws in Python -- every function that touches
 * the archive goes through this interface, so queue.ts/ingest.ts never know whether
 * they're talking to a real R2 bucket or an in-memory fixture. R2Store wraps the
 * Worker's R2Bucket binding (the real path, used by src/index.ts); MemoryStore is a
 * plain Map used by this package's own vitest suite (test/*.test.ts) -- no Miniflare
 * or live R2 needed to test ingest.ts/queue.ts's logic.
 */

export interface ArchiveStore {
  listKeys(prefix: string): Promise<string[]>;
  getBytes(key: string): Promise<Uint8Array>;
  putBytes(key: string, body: Uint8Array): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class R2Store implements ArchiveStore {
  constructor(private readonly bucket: R2Bucket) {}

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) keys.push(obj.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys.sort();
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`R2 object not found: ${key}`);
    return new Uint8Array(await obj.arrayBuffer());
  }

  async putBytes(key: string, body: Uint8Array): Promise<void> {
    await this.bucket.put(key, body);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bucket.head(key)) !== null;
  }
}

/** In-memory store for unit tests -- mirrors lib/r2.py's ARCHIVE_LOCAL_ROOT fallback in
 * spirit (no real R2 needed), but as a plain Map since vitest runs under Node, not the
 * Workers runtime, and doesn't need to touch a filesystem at all. */
export class MemoryStore implements ArchiveStore {
  private readonly files = new Map<string, Uint8Array>();

  seed(key: string, body: string | Uint8Array): void {
    this.files.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const bytes = this.files.get(key);
    if (!bytes) throw new Error(`not found: ${key}`);
    return bytes;
  }

  async putBytes(key: string, body: Uint8Array): Promise<void> {
    this.files.set(key, body);
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }
}

export async function getText(store: ArchiveStore, key: string): Promise<string> {
  return new TextDecoder().decode(await store.getBytes(key));
}

export async function getJson<T = unknown>(store: ArchiveStore, key: string): Promise<T> {
  return JSON.parse(await getText(store, key)) as T;
}

export async function putJson(store: ArchiveStore, key: string, value: unknown): Promise<void> {
  await store.putBytes(key, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}
