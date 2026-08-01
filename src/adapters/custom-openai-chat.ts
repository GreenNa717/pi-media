import type { AdapterRequest, MediaAsset, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import { joinEndpointUrl, requestJson } from "../http.ts";
import { isRecord } from "../utils.ts";
import {
  assertAssets,
  customOpenAIHeaders,
  defaultApiPath,
  emitDelta,
  inlineData,
  outputTokenLimit,
  parseOpenAIChatText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";
import { requestStreamingWithFallback } from "./streaming.ts";

async function send(
  endpoint: ResolvedEndpoint,
  content: unknown,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const path = endpoint.config.path ?? defaultApiPath(endpoint, "v1", "chat/completions");
  const body: Record<string, unknown> = {
    model: endpoint.config.model,
    messages: [{ role: "user", content }],
  };
  body[endpoint.config.maxTokensField] = maxTokens;
  const value = await requestJson(
    joinEndpointUrl(endpoint.baseUrl, path),
    () => ({ method: "POST", headers: customOpenAIHeaders(endpoint), body: JSON.stringify(body) }),
    { timeoutMs: endpoint.config.timeoutMs, retries: 1, ...(signal ? { signal } : {}), secrets: requestSecrets(endpoint) },
  );
  return parseOpenAIChatText(value);
}

async function sendStreaming(request: AdapterRequest, content: unknown, maxTokens: number): Promise<string> {
  const endpoint = request.endpoint;
  const path = endpoint.config.streamPath ?? endpoint.config.path ?? defaultApiPath(endpoint, "v1", "chat/completions");
  const body: Record<string, unknown> = {
    model: endpoint.config.model,
    messages: [{ role: "user", content }],
    stream: true,
  };
  body[endpoint.config.maxTokensField] = maxTokens;
  return requestStreamingWithFallback({
    url: joinEndpointUrl(endpoint.baseUrl, path),
    init: () => ({ method: "POST", headers: customOpenAIHeaders(endpoint), body: JSON.stringify(body) }),
    fetchOptions: {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(request.signal ? { signal: request.signal } : {}),
      secrets: requestSecrets(endpoint),
    },
    parser: {
      label: "Custom OpenAI Chat",
      parseJson: parseOpenAIChatText,
      parseEvent(value) {
        if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
        const choice = value.choices[0];
        if (!isRecord(choice) || !isRecord(choice.delta)) return undefined;
        const content = choice.delta.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return undefined;
        return content.filter(isRecord).map((part) => typeof part.text === "string" ? part.text : "").join("") || undefined;
      },
    },
    onDelta: (delta) => emitDelta(request, delta),
    nonStreaming: () => send(endpoint, content, maxTokens, request.signal),
  });
}

async function mediaPart(asset: MediaAsset): Promise<Record<string, unknown>> {
  const dataUrl = `data:${asset.mimeType};base64,${await inlineData(asset)}`;
  if (asset.kind === "image") return { type: "image_url", image_url: { url: dataUrl } };
  if (asset.kind === "audio") return { type: "input_audio", input_audio: { data: dataUrl } };
  if (asset.kind === "video") return { type: "video_url", video_url: { url: dataUrl } };
  throw new Error(`Custom OpenAI Chat does not define a ${asset.kind} content block`);
}

export const customOpenAIChatAdapter: ProtocolAdapter = {
  protocol: "custom-openai-chat",
  supportedKinds: ["image", "audio", "video"],
  async analyze(request: AdapterRequest) {
    assertAssets(request, this.supportedKinds);
    const content: unknown[] = [];
    for (const asset of request.assets) {
      if (asset.sizeBytes > request.endpoint.config.maxInlineBytes) {
        throw new Error(`${asset.name} exceeds the inline limit for Custom OpenAI Chat`);
      }
      content.push(await mediaPart(asset));
    }
    content.push({ type: "text", text: specialistPrompt(request.plan, request.assets) });
    const maxTokens = outputTokenLimit(request.endpoint, request.plan);
    const text = request.onProgress
      ? await sendStreaming(request, content, maxTokens)
      : await send(request.endpoint, content, maxTokens, request.signal);
    return reportFor(request, text);
  },
  async probe(endpoint, signal) {
    return send(endpoint, textProbePrompt(), 32, signal);
  },
};
