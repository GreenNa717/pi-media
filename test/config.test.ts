import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, loadRouterConfig } from "../src/config.ts";

const ENDPOINT = {
  protocol: "openai-chat",
  baseUrl: "http://localhost:1234/v1",
  model: "vision-model",
  modalities: ["image"],
  auth: { type: "none" },
};

test("merges global endpoints and replaces a project route", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-media-router-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "media-router.json"),
    JSON.stringify({ version: 1, endpoints: { main: ENDPOINT }, routes: { image: ["main"] } }),
  );
  await writeFile(
    join(cwd, ".pi", "media-router.json"),
    JSON.stringify({ version: 1, endpoints: { main: { model: "project-model" } }, routes: { image: [] } }),
  );

  const loaded = await loadRouterConfig(cwd, { agentDir });
  assert.equal(loaded.config.endpoints.main?.model, "project-model");
  assert.deepEqual(loaded.config.routes.image, []);
  assert.deepEqual(loaded.config.extensions.video.includes(".mp4"), true);
});

test("rejects a route to an unknown endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-media-router-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "media-router.json"), JSON.stringify({ version: 1, routes: { video: ["missing"] } }));
  await assert.rejects(loadRouterConfig(cwd, { agentDir }), ConfigError);
});

test("loads a custom endpoint and rejects unsafe API key headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-media-router-custom-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "media-router.json"), JSON.stringify({
    version: 1,
    endpoints: {
      custom: {
        protocol: "custom-openai-chat",
        baseUrl: "https://example.test/v1",
        model: "media-model",
        modalities: ["image", "audio", "video"],
        auth: { type: "none" },
        apiKeyHeader: "api-key",
        apiKeyPrefix: "",
      },
    },
    routes: { video: ["custom"] },
  }));
  const loaded = await loadRouterConfig(cwd, { agentDir });
  assert.equal(loaded.config.endpoints.custom?.apiKeyHeader, "api-key");
  assert.equal(loaded.config.endpoints.custom?.apiKeyPrefix, "");

  await writeFile(join(agentDir, "media-router.json"), JSON.stringify({
    version: 1,
    endpoints: {
      custom: {
        protocol: "custom-openai-chat",
        baseUrl: "https://example.test/v1",
        model: "media-model",
        modalities: ["image"],
        auth: { type: "none" },
        apiKeyHeader: "api-key\r\nx-leak",
      },
    },
  }));
  await assert.rejects(loadRouterConfig(cwd, { agentDir }), ConfigError);
});
