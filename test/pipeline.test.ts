import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { processMedia } from "../src/pipeline.ts";

test("bypasses attached images when the active Pi model supports images", async () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const context = {
    cwd: process.cwd(),
    model: { input: ["text", "image"] },
    ui: { setStatus() {} },
  } as unknown as ExtensionContext;
  const result = await processMedia(
    context,
    "describe this",
    [{ type: "image", mimeType: "image/png", data }],
    DEFAULT_CONFIG,
  );
  assert.equal(result?.reports.length, 0);
  assert.equal(result?.bypassedAssets.length, 1);
  assert.equal(result?.images[0]?.data, data);
  assert.equal(result?.text, "describe this");
});
