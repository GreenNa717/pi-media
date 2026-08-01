import { joinEndpointUrl, requestJson } from "../http.ts";
import type { AdapterRequest, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import {
  anthropicHeaders,
  assertAssets,
  defaultApiPath,
  inlineData,
  outputTokenLimit,
  parseAnthropicText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";

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
    const text = await send(request.endpoint, content, outputTokenLimit(request.endpoint, request.plan), request.signal);
    return reportFor(request, text);
  },
  async probe(endpoint, signal) {
    return send(endpoint, [{ type: "text", text: textProbePrompt() }], 32, signal);
  },
};
