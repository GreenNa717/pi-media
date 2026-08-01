import { joinEndpointUrl, requestJson } from "../http.ts";
import type { AdapterRequest, ProtocolAdapter, ResolvedEndpoint } from "../types.ts";
import {
  assertAssets,
  defaultApiPath,
  inlineData,
  openAIHeaders,
  outputTokenLimit,
  parseOpenAIResponsesText,
  reportFor,
  requestSecrets,
  specialistPrompt,
  textProbePrompt,
} from "./common.ts";

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
    const text = await send(request.endpoint, content, outputTokenLimit(request.endpoint, request.plan), request.signal);
    return reportFor(request, text);
  },
  async probe(endpoint, signal) {
    return send(endpoint, [{ type: "input_text", text: textProbePrompt() }], 32, signal);
  },
};
