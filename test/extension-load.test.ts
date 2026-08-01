import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi 0.83 loads the extension and registers its public surface", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-media-extension-load-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const extensionPath = resolve("src/index.ts");
  const loaded = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDir);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.path === extensionPath);
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()], ["media_query"]);
  assert.deepEqual([...extension.commands.keys()], ["media"]);
  assert.ok(extension.handlers.has("input"));
  assert.ok(extension.handlers.has("context"));
  assert.ok(extension.handlers.has("before_agent_start"));
  assert.ok(extension.handlers.has("session_shutdown"));
  assert.ok(extension.entryRenderers?.has("media-router-report"));
});
