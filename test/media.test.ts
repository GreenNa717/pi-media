import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_EXTENSIONS } from "../src/config.ts";
import { MediaInputError, parseMediaInput } from "../src/media.ts";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP3_HEADER = Buffer.from("ID3\u0004\u0000\u0000", "binary");
const MP4_HEADER = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const PDF_HEADER = Buffer.from("%PDF-1.7\n");

test("parses quoted @ paths with spaces and Unicode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  const file = join(directory, "sample image.png");
  await writeFile(file, PNG_HEADER);

  const result = await parseMediaInput(`inspect @"${file}"。`, undefined, directory, DEFAULT_EXTENSIONS);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.kind, "image");
  assert.equal(result.cleanedText, "inspect 。");
});

test("detects a bare path inserted by clipboard paste", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  const file = join(directory, "pi-clipboard-example.png");
  await writeFile(file, PNG_HEADER);
  const result = await parseMediaInput(`inspect ${file}`, undefined, directory, DEFAULT_EXTENSIONS);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.source.type, "file");
  assert.equal(result.cleanedText, "inspect");
});

test("detects an unquoted absolute path with spaces and Unicode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi media router-"));
  const file = join(directory, "示例 图片.png");
  await writeFile(file, PNG_HEADER);
  const result = await parseMediaInput(`这张 ${file} 里面有什么`, undefined, directory, DEFAULT_EXTENSIONS);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.name, "示例 图片.png");
  assert.equal(result.cleanedText, "这张 里面有什么");
});

test("keeps bare media paths in original order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  const first = join(directory, "first.png");
  const second = join(directory, "second.png");
  await writeFile(first, PNG_HEADER);
  await writeFile(second, PNG_HEADER);
  const result = await parseMediaInput(`compare ${first} with ${second}`, undefined, directory, DEFAULT_EXTENSIONS);
  assert.deepEqual(result.assets.map((asset) => asset.name), ["first.png", "second.png"]);
  assert.equal(result.cleanedText, "compare with");
});

test("detects bare image, audio, video, and PDF paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  const files = [
    { name: "image.PNG", data: PNG_HEADER, kind: "image" },
    { name: "audio.MP3", data: MP3_HEADER, kind: "audio" },
    { name: "video.MP4", data: MP4_HEADER, kind: "video" },
    { name: "document.PDF", data: PDF_HEADER, kind: "pdf" },
  ] as const;
  for (const file of files) await writeFile(join(directory, file.name), file.data);
  const input = files.map((file) => join(directory, file.name)).join(" ");
  const result = await parseMediaInput(input, undefined, directory, DEFAULT_EXTENSIONS);
  assert.deepEqual(result.assets.map((asset) => asset.kind), files.map((file) => file.kind));
  assert.equal(result.cleanedText, "");
});

test("ignores missing bare media-looking paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  const input = `does D:\\missing\\example.png work`;
  const result = await parseMediaInput(input, undefined, directory, DEFAULT_EXTENSIONS);
  assert.equal(result.assets.length, 0);
  assert.deepEqual(result.missingReferences, []);
  assert.equal(result.cleanedText, input);
});

test("keeps missing automatic references and rejects strict references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  const input = "inspect @missing.mp4";
  const automatic = await parseMediaInput(input, undefined, directory, DEFAULT_EXTENSIONS);
  assert.deepEqual(automatic.missingReferences, ["missing.mp4"]);
  assert.equal(automatic.cleanedText, input);
  await assert.rejects(
    parseMediaInput(input, undefined, directory, DEFAULT_EXTENSIONS, true),
    MediaInputError,
  );
});

test("rejects an extension and signature mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-"));
  await writeFile(join(directory, "fake.pdf"), "not a pdf");
  await assert.rejects(
    parseMediaInput("inspect @fake.pdf", undefined, directory, DEFAULT_EXTENSIONS, true),
    /signature does not match/,
  );
});

test("accepts a validated attached image", async () => {
  const result = await parseMediaInput(
    "describe it",
    [{ type: "image", mimeType: "image/png", data: PNG_HEADER.toString("base64") }],
    process.cwd(),
    DEFAULT_EXTENSIONS,
  );
  assert.equal(result.assets[0]?.name, "attachment-1");
  assert.equal(result.assets[0]?.sizeBytes, PNG_HEADER.length);
});
