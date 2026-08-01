import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_INLINE_SESSION_BYTES,
  MAX_SESSION_MEDIA,
  MediaSessionRegistry,
} from "../src/registry.ts";
import type { MediaAsset } from "../src/types.ts";

function inline(index: number, sizeBytes = 8): MediaAsset {
  return {
    id: `temporary-${index}`,
    index,
    kind: "image",
    name: `image-${index}.png`,
    mimeType: "image/png",
    sizeBytes,
    source: { type: "inline", data: "iVBORw0KGgo=" },
  };
}

test("assigns unique opaque IDs and clears all session media", async () => {
  const registry = new MediaSessionRegistry();
  const first = await registry.register([inline(0)]);
  const second = await registry.register([inline(0)]);
  assert.match(first[0]?.id ?? "", /^media_[a-f0-9]{24}$/);
  assert.notEqual(first[0]?.id, second[0]?.id);
  assert.equal((await registry.resolve([first[0]!.id]))[0]?.source.type, "inline");
  registry.clear();
  await assert.rejects(registry.resolve([first[0]!.id]), /Unknown or expired/);
});

test("evicts least recently used assets by count and inline bytes", async () => {
  const countRegistry = new MediaSessionRegistry();
  const registered = await countRegistry.register(
    Array.from({ length: MAX_SESSION_MEDIA + 1 }, (_, index) => inline(index)),
  );
  await assert.rejects(countRegistry.resolve([registered[0]!.id]), /Unknown or expired/);
  assert.equal((await countRegistry.resolve([registered.at(-1)!.id]))[0]?.name, `image-${MAX_SESSION_MEDIA}.png`);

  const byteRegistry = new MediaSessionRegistry();
  const large = await byteRegistry.register([
    inline(0, Math.floor(MAX_INLINE_SESSION_BYTES * 0.6)),
    inline(1, Math.floor(MAX_INLINE_SESSION_BYTES * 0.6)),
  ]);
  await assert.rejects(byteRegistry.resolve([large[0]!.id]), /Unknown or expired/);
  assert.equal((await byteRegistry.resolve([large[1]!.id]))[0]?.name, "image-1.png");
});

test("rejects arbitrary paths, unknown IDs, and more than eight assets", async () => {
  const registry = new MediaSessionRegistry();
  await assert.rejects(registry.resolve(["C:\\secret.png"]), /Paths and endpoint addresses are not accepted/);
  await assert.rejects(registry.resolve(["media_000000000000000000000000"]), /Unknown or expired/);
  await assert.rejects(
    registry.resolve(Array.from({ length: 9 }, () => "media_000000000000000000000000")),
    /at most 8/,
  );
});

test("revalidates file path, size, mtime, MIME, and signature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-registry-"));
  const path = join(directory, "sample.png");
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(path, original);
  const registry = new MediaSessionRegistry();
  const [asset] = await registry.register([{
    id: "temporary",
    index: 0,
    kind: "image",
    name: "sample.png",
    mimeType: "image/png",
    sizeBytes: original.length,
    source: { type: "file", path },
  }]);
  assert.equal((await registry.resolve([asset!.id]))[0]?.name, "sample.png");
  await writeFile(path, Buffer.concat([original, Buffer.from([1])]));
  await assert.rejects(registry.resolve([asset!.id]), /changed/);
  await assert.rejects(registry.resolve([asset!.id]), /Unknown or expired/);
});

test("rolls back a partial multi-file registration failure", async () => {
  const registry = new MediaSessionRegistry();
  await assert.rejects(registry.register([
    inline(0),
    {
      id: "temporary-file",
      index: 1,
      kind: "image",
      name: "missing.png",
      mimeType: "image/png",
      sizeBytes: 8,
      source: { type: "file", path: join(tmpdir(), `missing-${Date.now()}.png`) },
    },
  ]));
  assert.deepEqual(registry.descriptors(), []);
});
