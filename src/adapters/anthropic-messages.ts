import { joinEndpointUrl, requestJson } from "../http.ts";
import type { AdapterRequest, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import {
  anthropicHeaders,
  assertAssets,
  defaultApiPath,
  emitDelta,
  inlineData,
  outputTokenLimit,
  parseAnthropicText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";
import { requestStreamingWithFallback } from "./streaming.ts";
import { isRecord } from "../utils.ts";

async function send(endpoint: ResolvedEndpoint, content: unknown[], maxTokens: number, signal?: AbortSignal): Promise<string> {
  const path = endpoint.config.path ?? defaultApiPath(endpoint, "v1", "messages");
  const body = {
    model: endpoint.config.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
  const value = await requestJson(
    joinEndpointUrl(endpoint.baseUrl, path),
    () => ({ method: "POST", headers: anthropicHeaders(endpoint), body: JSON.stringify(body) }),
    { timeoutMs: endpoint.config.timeoutMs, retries: 1, ...(signal ? { signal } : {}), secrets: requestSecrets(endpoint) },
  );
  return parseAnthropicText(value);
}

async function sendStreaming(request: AdapterRequest, content: unknown[], maxTokens: number): Promise<string> {
  const endpoint = request.endpoint;
  const path = endpoint.config.streamPath ?? endpoint.config.path ?? defaultApiPath(endpoint, "v1", "messages");
  const body = {
    model: endpoint.config.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
    stream: true,
  };
  return requestStreamingWithFallback({
    url: joinEndpointUrl(endpoint.baseUrl, path),
    init: () => ({ method: "POST", headers: anthropicHeaders(endpoint), body: JSON.stringify(body) }),
    fetchOptions: {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(request.signal ? { signal: request.signal } : {}),
      secrets: requestSecrets(endpoint),
    },
    parser: {
      label: "Anthropic Messages",
      parseJson: parseAnthropicText,
      parseEvent(value, eventName) {
        if (!isRecord(value) || (eventName !== "content_block_delta" && value.type !== "content_block_delta")) return undefined;
        if (!isRecord(value.delta) || value.delta.type !== "text_delta") return undefined;
        return typeof value.delta.text === "string" ? value.delta.text : undefined;
      },
    },
    onDelta: (delta) => emitDelta(request, delta),
    nonStreaming: () => send(endpoint, content, maxTokens, request.signal),
  });
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: "anthropic-messages",
  supportedKinds: ["image", "pdf"],
  async analyze(request: AdapterRequest) {
    assertAssets(request, this.supportedKinds);
    const content: unknown[] = [{ type: "text", text: specialistPrompt(request.plan, request.assets) }];
    for (const asset of request.assets) {
      if (asset.sizeBytes > request.endpoint.config.maxInlineBytes) {
        throw new Error(`${asset.name} exceeds the inline limit for Anthropic Messages`);
      }
      const data = await inlineData(asset);
      if (asset.kind === "image") {
        content.push({ type: "image", source: { type: "base64", media_type: asset.mimeType, data } });
      } else {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      }
    }
    const maxTokens = outputTokenLimit(request.endpoint, request.plan);
    const text = request.onProgress
      ? await sendStreaming(request, content, maxTokens)
      : await send(request.endpoint, content, maxTokens, request.signal);
    return reportFor(request, text);
  },
  async probe(endpoint, signal) {
    return send(endpoint, [{ type: "text", text: textProbePrompt() }], 32, signal);
  },
};
