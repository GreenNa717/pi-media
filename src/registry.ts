import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { inspectMediaFile } from "./media.ts";
import type { MediaAsset, MediaKind } from "./types.ts";

export const MAX_SESSION_MEDIA = 32;
export const MAX_INLINE_SESSION_BYTES = 128 * 1024 * 1024;
export const MAX_QUERY_MEDIA = 8;

interface FileSnapshot {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  mimeType: string;
  kind: MediaKind;
}

interface RegistryEntry {
  asset: MediaAsset;
  file?: FileSnapshot;
  lastUsed: number;
}

export interface MediaDescriptor {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
}

export class MediaRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaRegistryError";
  }
}

function cloneAsset(asset: MediaAsset): MediaAsset {
  return {
    ...asset,
    source: asset.source.type === "file" ? { ...asset.source } : { ...asset.source },
  };
}

export class MediaSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly issuedIds = new Set<string>();
  private clock = 0;

  private nextId(): string {
    let id: string;
    do id = `media_${randomBytes(12).toString("hex")}`;
    while (this.issuedIds.has(id));
    this.issuedIds.add(id);
    return id;
  }

  async register(assets: readonly MediaAsset[]): Promise<MediaAsset[]> {
    const registered: MediaAsset[] = [];
    try {
      for (const source of assets) {
        const asset = cloneAsset({ ...source, id: this.nextId() });
        let file: FileSnapshot | undefined;
        if (asset.source.type === "file") {
          const info = await stat(asset.source.path);
          file = {
            path: asset.source.path,
            sizeBytes: asset.sizeBytes,
            mtimeMs: info.mtimeMs,
            mimeType: asset.mimeType,
            kind: asset.kind,
          };
        }
        this.entries.set(asset.id, { asset, ...(file ? { file } : {}), lastUsed: ++this.clock });
        registered.push(cloneAsset(asset));
      }
    } catch (error) {
      this.remove(registered.map((asset) => asset.id));
      throw error;
    }
    this.evict();
    return registered;
  }

  async resolve(assetIds: readonly string[]): Promise<MediaAsset[]> {
    if (assetIds.length === 0) throw new MediaRegistryError("assetIds must contain at least one media ID");
    if (assetIds.length > MAX_QUERY_MEDIA) {
      throw new MediaRegistryError(`media_query accepts at most ${MAX_QUERY_MEDIA} media IDs`);
    }
    if (new Set(assetIds).size !== assetIds.length) throw new MediaRegistryError("assetIds must not contain duplicates");

    const assets: MediaAsset[] = [];
    for (const id of assetIds) {
      if (!/^media_[a-f0-9]{24}$/.test(id)) {
        throw new MediaRegistryError(`Invalid media ID: ${id}. Paths and endpoint addresses are not accepted.`);
      }
      const entry = this.entries.get(id);
      if (!entry) throw new MediaRegistryError(`Unknown or expired media ID: ${id}. Send the media again.`);
      if (entry.file) await this.validateFile(entry.file, id);
      entry.lastUsed = ++this.clock;
      assets.push(cloneAsset(entry.asset));
    }
    return assets;
  }

  descriptors(): MediaDescriptor[] {
    return [...this.entries.values()]
      .sort((left, right) => left.lastUsed - right.lastUsed)
      .map(({ asset }) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      }));
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  remove(assetIds: readonly string[]): void {
    for (const id of assetIds) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
    this.issuedIds.clear();
    this.clock = 0;
  }

  private async validateFile(snapshot: FileSnapshot, id: string): Promise<void> {
    let inspected;
    try {
      inspected = await inspectMediaFile(snapshot.path, snapshot.kind);
    } catch {
      this.entries.delete(id);
      throw new MediaRegistryError(`Media ${id} is unavailable or changed. Send the file again.`);
    }
    if (
      inspected.source.type !== "file" ||
      inspected.source.path !== snapshot.path ||
      inspected.sizeBytes !== snapshot.sizeBytes ||
      inspected.mtimeMs !== snapshot.mtimeMs ||
      inspected.mimeType !== snapshot.mimeType
    ) {
      this.entries.delete(id);
      throw new MediaRegistryError(`Media ${id} changed after it was sent. Send the file again.`);
    }
  }

  private evict(): void {
    while (this.entries.size > MAX_SESSION_MEDIA) this.deleteLeastRecentlyUsed();
    while (this.inlineBytes() > MAX_INLINE_SESSION_BYTES) this.deleteLeastRecentlyUsed(true);
  }

  private inlineBytes(): number {
    let total = 0;
    for (const { asset } of this.entries.values()) {
      if (asset.source.type === "inline") total += asset.sizeBytes;
    }
    return total;
  }

  private deleteLeastRecentlyUsed(inlineOnly = false): void {
    let candidate: [string, RegistryEntry] | undefined;
    for (const item of this.entries) {
      if (inlineOnly && item[1].asset.source.type !== "inline") continue;
      if (!candidate || item[1].lastUsed < candidate[1].lastUsed) candidate = item;
    }
    if (candidate) this.entries.delete(candidate[0]);
  }
}
