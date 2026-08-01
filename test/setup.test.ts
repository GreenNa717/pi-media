import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveEndpoint } from "../src/auth.ts";
import { loadRouterConfig } from "../src/config.ts";
import { readStoredApiKey, storedCredentialsPath } from "../src/credentials.ts";
import { discoverModels, normalizeBaseUrl, saveSetup } from "../src/setup.ts";

test("discovers models for every protocol with the expected authentication", async (context) => {
  const requests: Array<{
    url: string;
    authorization?: string;
    apiKey?: string;
    googleKey?: string;
    anthropicVersion?: string;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof request.headers["x-api-key"] === "string" ? { apiKey: request.headers["x-api-key"] } : {}),
      ...(typeof request.headers["x-goog-api-key"] === "string" ? { googleKey: request.headers["x-goog-api-key"] } : {}),
      ...(typeof request.headers["anthropic-version"] === "string"
        ? { anthropicVersion: request.headers["anthropic-version"] }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/v1beta/models")) {
      response.end(JSON.stringify({
        models: [
          { name: "models/gemini-media", displayName: "Gemini Media", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed-only", supportedGenerationMethods: ["embedContent"] },
        ],
      }));
      return;
    }
    if (request.headers["anthropic-version"]) {
      response.end(JSON.stringify({
        data: [{ id: "claude-media", display_name: "Claude Media" }],
        has_more: false,
        first_id: "claude-media",
        last_id: "claude-media",
      }));
      return;
    }
    response.end(JSON.stringify({ data: [{ id: "vision-b" }, { id: "vision-a" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const chat = await discoverModels("openai-chat", `${base}/v1`, { apiKey: "test-key" });
  const responses = await discoverModels("openai-responses", `${base}/v1`, { apiKey: "test-key" });
  const anthropic = await discoverModels("anthropic-messages", `${base}/v1`, { apiKey: "test-key" });
  const gemini = await discoverModels("gemini", `${base}/v1beta`, { apiKey: "test-key" });

  assert.deepEqual(chat.map((model) => model.id), ["vision-a", "vision-b"]);
  assert.deepEqual(responses.map((model) => model.id), ["vision-a", "vision-b"]);
  assert.deepEqual(anthropic, [{ id: "claude-media", displayName: "Claude Media" }]);
  assert.deepEqual(gemini, [{ id: "gemini-media", displayName: "Gemini Media" }]);
  assert.equal(requests.filter((request) => request.authorization === "Bearer test-key").length, 2);
  assert.ok(requests.some((request) => request.apiKey === "test-key" && request.anthropicVersion === "2023-06-01"));
  assert.ok(requests.some((request) => request.url === "/v1beta/models?pageSize=1000" && request.googleKey === "test-key"));
});

test("saves setup without putting the API key in router config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-media-router-setup-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const targetPath = join(agentDir, "media-router.json");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(targetPath, JSON.stringify({ version: 1, customField: "preserved" }));

  const first = await saveSetup({
    targetPath,
    agentDir,
    baseRoutes: { image: [], audio: [], video: [], pdf: [] },
    endpointId: "media",
    protocol: "gemini",
    baseUrl: "http://localhost:9000/v1beta/",
    model: "gemini-media",
    modalities: ["image", "audio", "video", "pdf"],
    apiKey: "first-secret",
  });
  assert.ok(first.credentialId);
  let configText = await readFile(targetPath, "utf8");
  assert.equal(configText.includes("first-secret"), false);
  assert.equal(await readStoredApiKey(first.credentialId ?? "", { agentDir }), "first-secret");

  const loaded = await loadRouterConfig(cwd, { agentDir });
  assert.equal(loaded.config.endpoints.media?.auth.type, "stored");
  assert.deepEqual(loaded.config.routes.video, ["media"]);
  assert.equal((JSON.parse(configText) as { customField?: string }).customField, "preserved");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const endpointConfig = loaded.config.endpoints.media;
    assert.ok(endpointConfig);
    const resolved = await resolveEndpoint("media", endpointConfig, {} as ModelRegistry);
    assert.equal(resolved.apiKey, "first-secret");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }

  const second = await saveSetup({
    targetPath,
    agentDir,
    baseRoutes: loaded.config.routes,
    endpointId: "media",
    protocol: "openai-responses",
    baseUrl: "http://localhost:9001/v1",
    model: "openai-media",
    modalities: ["image", "pdf"],
    apiKey: "second-secret",
  });
  assert.equal(second.credentialId, first.credentialId);
  configText = await readFile(targetPath, "utf8");
  assert.equal(configText.includes("second-secret"), false);
  assert.equal(await readStoredApiKey(second.credentialId ?? "", { agentDir }), "second-secret");
  assert.deepEqual((JSON.parse(configText) as { routes: { audio: string[]; video: string[] } }).routes.audio, []);
  assert.deepEqual((JSON.parse(configText) as { routes: { audio: string[]; video: string[] } }).routes.video, []);
  assert.equal(storedCredentialsPath({ agentDir }), join(agentDir, "media-router", "credentials.json"));

  await saveSetup({
    targetPath,
    agentDir,
    baseRoutes: (await loadRouterConfig(cwd, { agentDir })).config.routes,
    endpointId: "media",
    protocol: "openai-responses",
    baseUrl: "http://localhost:9001/v1",
    model: "openai-media",
    modalities: ["image", "pdf"],
  });
  assert.equal(await readStoredApiKey(second.credentialId ?? "", { agentDir }), undefined);
});

test("validates setup URL and endpoint ID", async () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1/"), "https://example.com/v1");
  assert.throws(() => normalizeBaseUrl("file:///tmp/models"));
  assert.throws(() => normalizeBaseUrl("https://user:secret@example.com/v1"));
  const root = await mkdtemp(join(tmpdir(), "pi-media-router-setup-invalid-"));
  await assert.rejects(
    saveSetup({
      targetPath: join(root, "media-router.json"),
      baseRoutes: { image: [], audio: [], video: [], pdf: [] },
      endpointId: "bad id",
      protocol: "openai-chat",
      baseUrl: "http://localhost:1234/v1",
      model: "model",
      modalities: ["image"],
    }),
    /端点 ID/,
  );
});
