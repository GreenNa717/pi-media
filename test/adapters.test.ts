import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  anthropicMessagesAdapter,
  geminiAdapter,
  openAIChatAdapter,
  openAIResponsesAdapter,
} from "../src/adapters/index.ts";
import type {
  AdapterProtocol,
  AnalysisPlan,
  EndpointConfig,
  MediaAsset,
  ResolvedEndpoint,
} from "../src/types.ts";

const PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const IMAGE: MediaAsset = {
  id: "media-1",
  index: 0,
  kind: "image",
  name: "sample.png",
  mimeType: "image/png",
  sizeBytes: 8,
  source: { type: "inline", data: PNG_DATA },
};
const PDF: MediaAsset = {
  id: "media-2",
  index: 1,
  kind: "pdf",
  name: "sample.pdf",
  mimeType: "application/pdf",
  sizeBytes: 8,
  source: { type: "inline", data: Buffer.from("%PDF-1.7").toString("base64") },
};
const PLAN: AnalysisPlan = {
  objective: "inspect the files",
  instructions: ["Return visible evidence"],
  outputLanguage: "English",
  detail: "task",
  includeTimestamps: true,
  assetFocus: [
    { assetId: "media-1", focus: "image content" },
    { assetId: "media-2", focus: "document content" },
  ],
};

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sse(response: ServerResponse, chunks: readonly string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}

function endpoint(base: string, protocol: AdapterProtocol, modalities: EndpointConfig["modalities"]): ResolvedEndpoint {
  const version = protocol === "gemini" ? "v1beta" : "v1";
  return {
    id: protocol,
    baseUrl: `${base}/${version}`,
    headers: {},
    config: {
      protocol,
      baseUrl: `${base}/${version}`,
      model: protocol === "gemini" ? "gemini-test" : "test-model",
      modalities,
      auth: { type: "none" },
      headers: {},
      timeoutMs: 5_000,
      maxBytes: 10_000,
      maxInlineBytes: 10_000,
      maxOutputTokens: 256,
      fullMaxOutputTokens: 512,
      maxTokensField: "max_tokens",
      geminiVariant: "generate-content",
    },
  };
}

test("serializes and parses all four protocol adapters", async (context) => {
  const payloads = new Map<string, unknown>();
  let chatAttempts = 0;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    payloads.set(path, await requestBody(request));
    if (path === "/v1/chat/completions") {
      chatAttempts += 1;
      if (chatAttempts === 1) return json(response, { error: "retry" }, 500);
      return json(response, { choices: [{ message: { content: "chat report" } }] });
    }
    if (path === "/v1/responses") {
      return json(response, { output: [{ content: [{ type: "output_text", text: "responses report" }] }] });
    }
    if (path === "/v1/messages") return json(response, { content: [{ type: "text", text: "anthropic report" }] });
    if (path === "/v1beta/models/gemini-test:generateContent") {
      return json(response, { candidates: [{ content: { parts: [{ text: "gemini report" }] } }] });
    }
    return json(response, { error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const chat = await openAIChatAdapter.analyze({ endpoint: endpoint(base, "openai-chat", ["image"]), assets: [IMAGE], plan: PLAN });
  const responses = await openAIResponsesAdapter.analyze({
    endpoint: endpoint(base, "openai-responses", ["image", "pdf"]),
    assets: [IMAGE, PDF],
    plan: PLAN,
  });
  const anthropic = await anthropicMessagesAdapter.analyze({
    endpoint: endpoint(base, "anthropic-messages", ["image", "pdf"]),
    assets: [IMAGE, PDF],
    plan: PLAN,
  });
  const gemini = await geminiAdapter.analyze({ endpoint: endpoint(base, "gemini", ["image"]), assets: [IMAGE], plan: PLAN });

  assert.equal(chat.text, "chat report");
  assert.equal(chatAttempts, 2);
  assert.equal(responses.text, "responses report");
  assert.equal(anthropic.text, "anthropic report");
  assert.equal(gemini.text, "gemini report");

  const chatBody = payloads.get("/v1/chat/completions") as { messages: Array<{ content: unknown[] }> };
  assert.equal((chatBody.messages[0]?.content[1] as { type: string }).type, "image_url");
  const responsesBody = payloads.get("/v1/responses") as { input: Array<{ content: Array<{ type: string }> }> };
  assert.deepEqual(responsesBody.input[0]?.content.slice(1).map((part) => part.type), ["input_image", "input_file"]);
  const anthropicBody = payloads.get("/v1/messages") as { messages: Array<{ content: Array<{ type: string }> }> };
  assert.deepEqual(anthropicBody.messages[0]?.content.slice(1).map((part) => part.type), ["image", "document"]);
  const geminiBody = payloads.get("/v1beta/models/gemini-test:generateContent") as {
    contents: Array<{ parts: Array<Record<string, unknown>> }>;
  };
  assert.ok(geminiBody.contents[0]?.parts[1]?.inlineData);
});

test("Gemini uploads, polls, analyzes, and deletes a large file", async (context) => {
  const calls: string[] = [];
  let base = "";
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    calls.push(`${request.method} ${path}`);
    for await (const _chunk of request) {
      // Consume upload bodies before replying.
    }
    if (path === "/upload/v1beta/files") {
      response.writeHead(200, { "x-goog-upload-url": `${base}/upload-session` });
      return response.end();
    }
    if (path === "/upload-session") {
      return json(response, { file: { name: "files/media123", uri: "gemini://media123", mimeType: "video/mp4", state: "PROCESSING" } });
    }
    if (path === "/v1beta/files/media123" && request.method === "GET") {
      return json(response, { name: "files/media123", uri: "gemini://media123", mimeType: "video/mp4", state: "ACTIVE" });
    }
    if (path === "/v1beta/files/media123" && request.method === "DELETE") {
      response.writeHead(204);
      return response.end();
    }
    if (path === "/v1beta/models/gemini-test:generateContent") {
      return json(response, { candidates: [{ content: { parts: [{ text: "video report" }] } }] });
    }
    return json(response, { error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  const directory = await mkdtemp(join(tmpdir(), "pi-media-router-upload-"));
  const file = join(directory, "clip.mp4");
  const content = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  await writeFile(file, content);
  const video: MediaAsset = {
    id: "media-3",
    index: 0,
    kind: "video",
    name: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: content.length,
    source: { type: "file", path: file },
  };
  const resolved = endpoint(base, "gemini", ["video"]);
  resolved.config.maxInlineBytes = 1;
  const report = await geminiAdapter.analyze({
    endpoint: resolved,
    assets: [video],
    plan: { ...PLAN, assetFocus: [{ assetId: "media-3", focus: "events" }] },
  });
  assert.equal(report.text, "video report");
  assert.deepEqual(calls, [
    "POST /upload/v1beta/files",
    "POST /upload-session",
    "GET /v1beta/files/media123",
    "POST /v1beta/models/gemini-test:generateContent",
    "DELETE /v1beta/files/media123",
  ]);
});

test("streams deltas from every supported protocol variant", async (context) => {
  const bodies = new Map<string, unknown>();
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    bodies.set(path, await requestBody(request));
    if (path === "/v1/chat/completions") {
      return sse(response, [
        'data: {"choices":[{"delta":{"content":"chat "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"stream"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    if (path === "/v1/responses") {
      return sse(response, [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"responses "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"stream"}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    if (path === "/v1/messages") {
      return sse(response, [
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream"}}\n\n',
      ]);
    }
    if (path === "/v1beta/models/gemini-test:streamGenerateContent?alt=sse") {
      return sse(response, [
        'data: {"candidates":[{"content":{"parts":[{"text":"gemini "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"stream"}]}}]}\n\n',
      ]);
    }
    if (path === "/v1beta/interactions") {
      return sse(response, [
        'event: step.delta\ndata: {"type":"step.delta","delta":{"type":"text","text":"interaction "}}\n\n',
        'event: step.delta\ndata: {"type":"step.delta","delta":{"type":"text","text":"stream"}}\n\n',
      ]);
    }
    return json(response, { error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const deltas: string[] = [];
  const onProgress = (event: { phase: string; delta?: string }) => {
    if (event.phase === "delta" && event.delta) deltas.push(event.delta);
  };

  const chat = await openAIChatAdapter.analyze({ endpoint: endpoint(base, "openai-chat", ["image"]), assets: [IMAGE], plan: PLAN, onProgress });
  const responses = await openAIResponsesAdapter.analyze({ endpoint: endpoint(base, "openai-responses", ["image"]), assets: [IMAGE], plan: PLAN, onProgress });
  const anthropic = await anthropicMessagesAdapter.analyze({ endpoint: endpoint(base, "anthropic-messages", ["image"]), assets: [IMAGE], plan: PLAN, onProgress });
  const geminiEndpoint = endpoint(base, "gemini", ["image"]);
  const gemini = await geminiAdapter.analyze({ endpoint: geminiEndpoint, assets: [IMAGE], plan: PLAN, onProgress });
  const interactionEndpoint = endpoint(base, "gemini", ["image"]);
  interactionEndpoint.config.geminiVariant = "interactions";
  const interaction = await geminiAdapter.analyze({ endpoint: interactionEndpoint, assets: [IMAGE], plan: PLAN, onProgress });

  assert.equal(chat.text, "chat stream");
  assert.equal(responses.text, "responses stream");
  assert.equal(anthropic.text, "anthropic stream");
  assert.equal(gemini.text, "gemini stream");
  assert.equal(interaction.text, "interaction stream");
  assert.ok(deltas.length >= 10);
  assert.equal((bodies.get("/v1/chat/completions") as { stream: boolean }).stream, true);
  assert.equal((bodies.get("/v1/responses") as { stream: boolean }).stream, true);
  assert.equal((bodies.get("/v1/messages") as { stream: boolean }).stream, true);
  assert.equal((bodies.get("/v1beta/interactions") as { stream: boolean }).stream, true);
});

test("falls back to JSON only when streaming is rejected before a delta", async (context) => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    calls.push(path);
    await requestBody(request);
    if (path === "/stream") return json(response, { error: "stream unsupported" }, 404);
    if (path === "/v1/responses") {
      return json(response, { output: [{ content: [{ type: "output_text", text: "JSON fallback" }] }] });
    }
    return json(response, { error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const resolved = endpoint(`http://127.0.0.1:${address.port}`, "openai-responses", ["image"]);
  resolved.config.streamPath = "/stream";
  const deltas: string[] = [];
  const report = await openAIResponsesAdapter.analyze({
    endpoint: resolved,
    assets: [IMAGE],
    plan: PLAN,
    onProgress: (event) => { if (event.delta) deltas.push(event.delta); },
  });
  assert.equal(report.text, "JSON fallback");
  assert.deepEqual(calls, ["/stream", "/v1/responses"]);
  assert.deepEqual(deltas, ["JSON fallback"]);
});

test("redacts secrets from a stream error after partial output", async (context) => {
  const secret = "do-not-leak-this-key";
  const server = createServer(async (request, response) => {
    await requestBody(request);
    sse(response, [
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      `event: error\ndata: ${JSON.stringify({ message: `provider echoed ${secret}` })}\n\n`,
    ]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const resolved = endpoint(`http://127.0.0.1:${address.port}`, "openai-responses", ["image"]);
  resolved.apiKey = secret;
  await assert.rejects(
    openAIResponsesAdapter.analyze({ endpoint: resolved, assets: [IMAGE], plan: PLAN, onProgress() {} }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.includes("[REDACTED]"));
      assert.ok(!message.includes(secret));
      return true;
    },
  );
});
