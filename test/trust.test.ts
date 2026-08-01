import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isUploadTrusted, rememberUploadTrust, resetUploadTrust } from "../src/trust.ts";

test("trust is scoped to a project and endpoint host fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-media-router-trust-"));
  const store = join(root, "state", "trust.json");
  assert.equal(await isUploadTrusted(root, ["api.example.com"], store), false);
  await rememberUploadTrust(root, ["api.example.com"], store);
  assert.equal(await isUploadTrusted(root, ["api.example.com"], store), true);
  assert.equal(await isUploadTrusted(root, ["other.example.com"], store), false);
  assert.equal(await resetUploadTrust(root, store), true);
  assert.equal(await isUploadTrusted(root, ["api.example.com"], store), false);
});
