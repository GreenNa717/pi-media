import { createReadStream } from "node:fs";
import { joinEndpointUrl, fetchWithRetry, requestJson, type FetchInit } from "../http.ts";
import { assetBuffer } from "../media.ts";
import type { AdapterRequest, MediaAsset, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import { isRecord, sleep } from "../utils.ts";
import {
  assertAssets,
  defaultApiPath,
  emitDelta,
  geminiHeaders,
  inlineData,
  outputTokenLimit,
  parseGeminiText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";
import { requestStreamingWithFallback } from "./streaming.ts";

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
}

function parseUploadedFile(value: unknown): UploadedFile {
  const root = isRecord(value) && isRecord(value.file) ? value.file : value;
  if (!isRecord(root) || typeof root.name !== "string" || typeof root.uri !== "string") {
    throw new Error("Gemini Files API returned an invalid file object");
  }
  const mimeType = typeof root.mimeType === "string" ? root.mimeType : typeof root.mime_type === "string" ? root.mime_type : undefined;
  if (!mimeType) throw new Error("Gemini Files API omitted the MIME type");
  const rawState = root.state;
  const state = typeof rawState === "string" ? rawState : isRecord(rawState) && typeof rawState.name === "string" ? rawState.name : undefined;
  return { name: root.name, uri: root.uri, mimeType, ...(state ? { state } : {}) };
}

function versionBaseUrl(endpoint: ResolvedEndpoint): string {
  const url = new URL(endpoint.baseUrl);
  return url.pathname.replace(/\/+$/, "").endsWith("/v1beta")
    ? endpoint.baseUrl
    : joinEndpointUrl(endpoint.baseUrl, "/v1beta").replace(/\/$/, "");
}

function uploadUrl(endpoint: ResolvedEndpoint): string {
  if (endpoint.config.uploadPath) return joinEndpointUrl(endpoint.baseUrl, endpoint.config.uploadPath);
  return joinEndpointUrl(endpoint.baseUrl, "/upload/v1beta/files");
}

function uploadHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
  const headers = geminiHeaders(endpoint);
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "content-type") delete headers[name];
  }
  return headers;
}

async function parseResponseJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function uploadAsset(endpoint: ResolvedEndpoint, asset: MediaAsset, signal?: AbortSignal): Promise<UploadedFile> {
  const startHeaders = uploadHeaders(endpoint);
  startHeaders["content-type"] = "application/json";
  startHeaders["x-goog-upload-protocol"] = "resumable";
  startHeaders["x-goog-upload-command"] = "start";
  startHeaders["x-goog-upload-header-content-length"] = String(asset.sizeBytes);
  startHeaders["x-goog-upload-header-content-type"] = asset.mimeType;

  const startResponse = await fetchWithRetry(
    uploadUrl(endpoint),
    () => ({
      method: "POST",
      headers: startHeaders,
      body: JSON.stringify({ file: { display_name: asset.name } }),
    }),
    {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(signal ? { signal } : {}),
      secrets: requestSecrets(endpoint),
    },
  );
  const resumableUrl = startResponse.headers.get("x-goog-upload-url");
  if (!resumableUrl) throw new Error("Gemini Files API did not return x-goog-upload-url");

  const finalizeResponse = await fetchWithRetry(
    resumableUrl,
    async (): Promise<FetchInit> => {
      const body = asset.source.type === "file" ? createReadStream(asset.source.path) : await assetBuffer(asset);
      return {
        method: "POST",
        headers: {
          ...uploadHeaders(endpoint),
          "content-length": String(asset.sizeBytes),
          "content-type": asset.mimeType,
          "x-goog-upload-offset": "0",
          "x-goog-upload-command": "upload, finalize",
        },
        body: body as unknown as BodyInit,
        duplex: "half",
      };
    },
    {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(signal ? { signal } : {}),
      secrets: requestSecrets(endpoint),
    },
  );
  return parseUploadedFile(await parseResponseJson(finalizeResponse, "Gemini file upload"));
}

async function waitUntilActive(endpoint: ResolvedEndpoint, uploaded: UploadedFile, signal?: AbortSignal): Promise<UploadedFile> {
  let current = uploaded;
  const deadline = Date.now() + endpoint.config.timeoutMs;
  while (current.state && !["ACTIVE", "STATE_ACTIVE"].includes(current.state.toUpperCase())) {
    if (["FAILED", "STATE_FAILED"].includes(current.state.toUpperCase())) {
      throw new Error(`Gemini failed to process uploaded file ${uploaded.name}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Gemini to process ${uploaded.name}`);
    await sleep(1_000, signal);
    const value = await requestJson(
      joinEndpointUrl(versionBaseUrl(endpoint), current.name),
      () => ({ method: "GET", headers: uploadHeaders(endpoint) }),
      {
        timeoutMs: Math.min(30_000, endpoint.config.timeoutMs),
        retries: 1,
        ...(signal ? { signal } : {}),
        secrets: requestSecrets(endpoint),
      },
    );
    current = parseUploadedFile(value);
  }
  return current;
}

async function deleteUploadedFile(endpoint: ResolvedEndpoint, file: UploadedFile, signal?: AbortSignal): Promise<void> {
  await fetchWithRetry(
    joinEndpointUrl(versionBaseUrl(endpoint), file.name),
    () => ({ method: "DELETE", headers: uploadHeaders(endpoint) }),
    {
      timeoutMs: Math.min(30_000, endpoint.config.timeoutMs),
      retries: 1,
      ...(signal ? { signal } : {}),
      secrets: requestSecrets(endpoint),
    },
  );
}

function interactionType(asset: MediaAsset): "image" | "audio" | "video" | "document" {
  return asset.kind === "pdf" ? "document" : asset.kind;
}

async function sendGenerateContent(
  endpoint: ResolvedEndpoint,
  prompt: string,
  parts: unknown[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const model = endpoint.config.model.replace(/^models\//, "");
  const path = endpoint.config.path ?? defaultApiPath(endpoint, "v1beta", `models/${encodeURIComponent(model)}:generateContent`);
  const value = await requestJson(
    joinEndpointUrl(endpoint.baseUrl, path),
    () => ({
      method: "POST",
      headers: geminiHeaders(endpoint),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }),
    {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(signal ? { signal } : {}),
      secrets: requestSecrets(endpoint),
    },
  );
  return parseGeminiText(value);
}

async function sendInteractions(
  endpoint: ResolvedEndpoint,
  prompt: string,
  input: unknown[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const path = endpoint.config.path ?? defaultApiPath(endpoint, "v1beta", "interactions");
  const value = await requestJson(
    joinEndpointUrl(endpoint.baseUrl, path),
    () => ({
      method: "POST",
      headers: geminiHeaders(endpoint),
      body: JSON.stringify({
        model: endpoint.config.model.replace(/^models\//, ""),
        input: [{ type: "text", text: prompt }, ...input],
        generation_config: { max_output_tokens: maxTokens },
      }),
    }),
    {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(signal ? { signal } : {}),
      secrets: requestSecrets(endpoint),
    },
  );
  return parseGeminiText(value);
}

function appendSseQuery(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}alt=sse`;
}

function defaultGenerateStreamPath(endpoint: ResolvedEndpoint, model: string): string {
  if (endpoint.config.streamPath) return endpoint.config.streamPath;
  if (endpoint.config.path) {
    const derived = endpoint.config.path.replace(":generateContent", ":streamGenerateContent");
    return appendSseQuery(derived);
  }
  return appendSseQuery(defaultApiPath(endpoint, "v1beta", `models/${encodeURIComponent(model)}:streamGenerateContent`));
}

function geminiDelta(value: unknown, eventName?: string): string | undefined {
  if (!isRecord(value)) return undefined;
  if (eventName === "step.delta" || value.type === "step.delta" || value.event_type === "step.delta") {
    const delta = value.delta;
    if (typeof delta === "string") return delta;
    if (isRecord(delta) && typeof delta.text === "string") return delta.text;
  }
  if (isRecord(value.delta) && value.delta.type === "text" && typeof value.delta.text === "string") {
    return value.delta.text;
  }
  if (Array.isArray(value.candidates)) {
    const text = value.candidates
      .filter(isRecord)
      .flatMap((candidate) => isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [])
      .filter(isRecord)
      .map((part) => typeof part.text === "string" ? part.text : "")
      .join("");
    if (text) return text;
  }
  try {
    return parseGeminiText(value);
  } catch {
    return undefined;
  }
}

async function sendGenerateContentStreaming(
  request: AdapterRequest,
  prompt: string,
  parts: unknown[],
  maxTokens: number,
): Promise<string> {
  const endpoint = request.endpoint;
  const model = endpoint.config.model.replace(/^models\//, "");
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  return requestStreamingWithFallback({
    url: joinEndpointUrl(endpoint.baseUrl, defaultGenerateStreamPath(endpoint, model)),
    init: () => ({ method: "POST", headers: geminiHeaders(endpoint), body: JSON.stringify(body) }),
    fetchOptions: {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(request.signal ? { signal: request.signal } : {}),
      secrets: requestSecrets(endpoint),
    },
    parser: { label: "Gemini GenerateContent", parseJson: parseGeminiText, parseEvent: geminiDelta },
    onDelta: (delta) => emitDelta(request, delta),
    nonStreaming: () => sendGenerateContent(endpoint, prompt, parts, maxTokens, request.signal),
  });
}

async function sendInteractionsStreaming(
  request: AdapterRequest,
  prompt: string,
  input: unknown[],
  maxTokens: number,
): Promise<string> {
  const endpoint = request.endpoint;
  const path = endpoint.config.streamPath ?? endpoint.config.path ?? defaultApiPath(endpoint, "v1beta", "interactions");
  const body = {
    model: endpoint.config.model.replace(/^models\//, ""),
    input: [{ type: "text", text: prompt }, ...input],
    generation_config: { max_output_tokens: maxTokens },
    stream: true,
  };
  return requestStreamingWithFallback({
    url: joinEndpointUrl(endpoint.baseUrl, path),
    init: () => ({ method: "POST", headers: geminiHeaders(endpoint), body: JSON.stringify(body) }),
    fetchOptions: {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(request.signal ? { signal: request.signal } : {}),
      secrets: requestSecrets(endpoint),
    },
    parser: { label: "Gemini Interactions", parseJson: parseGeminiText, parseEvent: geminiDelta },
    onDelta: (delta) => emitDelta(request, delta),
    nonStreaming: () => sendInteractions(endpoint, prompt, input, maxTokens, request.signal),
  });
}

async function sendTextProbe(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<string> {
  if (endpoint.config.geminiVariant === "interactions") {
    return sendInteractions(endpoint, textProbePrompt(), [], 32, signal);
  }
  return sendGenerateContent(endpoint, textProbePrompt(), [], 32, signal);
}

export const geminiAdapter: ProtocolAdapter = {
  protocol: "gemini",
  supportedKinds: ["image", "audio", "video", "pdf"],
  async analyze(request: AdapterRequest) {
    assertAssets(request, this.supportedKinds);
    const prompt = specialistPrompt(request.plan, request.assets);
    const uploadedFiles: UploadedFile[] = [];
    const generateParts: unknown[] = [];
    const interactionInput: unknown[] = [];
    const warnings: string[] = [];

    try {
      for (const asset of request.assets) {
        if (asset.sizeBytes <= request.endpoint.config.maxInlineBytes) {
          const data = await inlineData(asset);
          generateParts.push({ inlineData: { mimeType: asset.mimeType, data } });
          interactionInput.push({ type: interactionType(asset), data, mime_type: asset.mimeType });
        } else {
          request.onProgress?.({
            phase: "upload",
            endpointId: request.endpoint.id,
            protocol: request.endpoint.config.protocol,
            model: request.endpoint.config.model,
            assetIds: request.assets.map((item) => item.id),
            assetNames: request.assets.map((item) => item.name),
            message: `Uploading ${asset.name}`,
          });
          const uploaded = await waitUntilActive(
            request.endpoint,
            await uploadAsset(request.endpoint, asset, request.signal),
            request.signal,
          );
          uploadedFiles.push(uploaded);
          generateParts.push({ fileData: { mimeType: uploaded.mimeType, fileUri: uploaded.uri } });
          interactionInput.push({
            type: interactionType(asset),
            uri: uploaded.uri,
            mime_type: uploaded.mimeType,
          });
        }
      }

      const maxTokens = outputTokenLimit(request.endpoint, request.plan);
      const text =
        request.endpoint.config.geminiVariant === "interactions"
          ? request.onProgress
            ? await sendInteractionsStreaming(request, prompt, interactionInput, maxTokens)
            : await sendInteractions(request.endpoint, prompt, interactionInput, maxTokens, request.signal)
          : request.onProgress
            ? await sendGenerateContentStreaming(request, prompt, generateParts, maxTokens)
            : await sendGenerateContent(request.endpoint, prompt, generateParts, maxTokens, request.signal);
      return reportFor(request, text, warnings);
    } finally {
      for (const uploaded of uploadedFiles) {
        try {
          await deleteUploadedFile(request.endpoint, uploaded);
        } catch {
          warnings.push(`Could not delete remote file ${uploaded.name}; the provider may retain it until expiry.`);
        }
      }
    }
  },
  async probe(endpoint, signal) {
    return sendTextProbe(endpoint, signal);
  },
};
