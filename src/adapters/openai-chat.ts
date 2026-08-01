import { joinEndpointUrl, requestJson } from "../http.ts";
import type { AdapterRequest, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import {
  assertAssets,
  defaultApiPath,
  emitDelta,
  inlineData,
  openAIHeaders,
  outputTokenLimit,
  parseOpenAIChatText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";
import { requestStreamingWithFallback } from "./streaming.ts";
import { isRecord } from "../utils.ts";

async function send(endpoint: ResolvedEndpoint, content: unknown, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const path = endpoint.config.path ?? defaultApiPath(endpoint, "v1", "chat/completions");
  const body: Record<string, unknown> = {
    model: endpoint.config.model,
    messages: [{ role: "user", content }],
  };
  body[endpoint.config.maxTokensField] = maxTokens;
  const value = await requestJson(
    joinEndpointUrl(endpoint.baseUrl, path),
    () => ({ method: "POST", headers: openAIHeaders(endpoint), body: JSON.stringify(body) }),
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
    init: () => ({ method: "POST", headers: openAIHeaders(endpoint), body: JSON.stringify(body) }),
    fetchOptions: {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(request.signal ? { signal: request.signal } : {}),
      secrets: requestSecrets(endpoint),
    },
    parser: {
      label: "OpenAI Chat",
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

export const openAIChatAdapter: ProtocolAdapter = {
  protocol: "openai-chat",
  supportedKinds: ["image", "audio"],
  async analyze(request: AdapterRequest) {
    assertAssets(request, this.supportedKinds);
    const content: unknown[] = [{ type: "text", text: specialistPrompt(request.plan, request.assets) }];
    for (const asset of request.assets) {
      if (asset.sizeBytes > request.endpoint.config.maxInlineBytes) {
        throw new Error(`${asset.name} exceeds the inline limit for OpenAI Chat`);
      }
      const data = await inlineData(asset);
      if (asset.kind === "image") {
        content.push({ type: "image_url", image_url: { url: `data:${asset.mimeType};base64,${data}` } });
      } else {
        const format = asset.mimeType === "audio/wav" ? "wav" : asset.mimeType === "audio/mpeg" ? "mp3" : undefined;
        if (!format) throw new Error(`OpenAI Chat input_audio officially supports only WAV or MP3, not ${asset.mimeType}`);
        content.push({ type: "input_audio", input_audio: { data, format } });
      }
    }
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
