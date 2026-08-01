import { joinEndpointUrl, requestJson } from "../http.ts";
import type { AdapterRequest, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import {
  assertAssets,
  defaultApiPath,
  emitDelta,
  inlineData,
  openAIHeaders,
  outputTokenLimit,
  parseOpenAIResponsesText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";
import { requestStreamingWithFallback } from "./streaming.ts";
import { isRecord } from "../utils.ts";

async function send(endpoint: ResolvedEndpoint, content: unknown[], maxTokens: number, signal?: AbortSignal): Promise<string> {
  const path = endpoint.config.path ?? defaultApiPath(endpoint, "v1", "responses");
  const body = {
    model: endpoint.config.model,
    input: [{ role: "user", content }],
    max_output_tokens: maxTokens,
  };
  const value = await requestJson(
    joinEndpointUrl(endpoint.baseUrl, path),
    () => ({ method: "POST", headers: openAIHeaders(endpoint), body: JSON.stringify(body) }),
    { timeoutMs: endpoint.config.timeoutMs, retries: 1, ...(signal ? { signal } : {}), secrets: requestSecrets(endpoint) },
  );
  return parseOpenAIResponsesText(value);
}

async function sendStreaming(request: AdapterRequest, content: unknown[], maxTokens: number): Promise<string> {
  const endpoint = request.endpoint;
  const path = endpoint.config.streamPath ?? endpoint.config.path ?? defaultApiPath(endpoint, "v1", "responses");
  const body = {
    model: endpoint.config.model,
    input: [{ role: "user", content }],
    max_output_tokens: maxTokens,
    stream: true,
  };
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
      label: "OpenAI Responses",
      parseJson: parseOpenAIResponsesText,
      parseEvent(value) {
        if (!isRecord(value) || value.type !== "response.output_text.delta") return undefined;
        return typeof value.delta === "string" ? value.delta : undefined;
      },
    },
    onDelta: (delta) => emitDelta(request, delta),
    nonStreaming: () => send(endpoint, content, maxTokens, request.signal),
  });
}

export const openAIResponsesAdapter: ProtocolAdapter = {
  protocol: "openai-responses",
  supportedKinds: ["image", "pdf"],
  async analyze(request: AdapterRequest) {
    assertAssets(request, this.supportedKinds);
    const content: unknown[] = [{ type: "input_text", text: specialistPrompt(request.plan, request.assets) }];
    for (const asset of request.assets) {
      if (asset.sizeBytes > request.endpoint.config.maxInlineBytes) {
        throw new Error(`${asset.name} exceeds the inline limit for OpenAI Responses`);
      }
      const data = await inlineData(asset);
      if (asset.kind === "image") {
        content.push({ type: "input_image", detail: "auto", image_url: `data:${asset.mimeType};base64,${data}` });
      } else {
        content.push({
          type: "input_file",
          filename: asset.name,
          file_data: `data:${asset.mimeType};base64,${data}`,
        });
      }
    }
    const maxTokens = outputTokenLimit(request.endpoint, request.plan);
    const text = request.onProgress
      ? await sendStreaming(request, content, maxTokens)
      : await send(request.endpoint, content, maxTokens, request.signal);
    return reportFor(request, text);
  },
  async probe(endpoint, signal) {
    return send(endpoint, [{ type: "input_text", text: textProbePrompt() }], 32, signal);
  },
};
