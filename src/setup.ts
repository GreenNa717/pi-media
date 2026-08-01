import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { anthropicHeaders, defaultApiPath, geminiHeaders, openAIHeaders, PROTOCOL_KINDS, requestSecrets } from "./adapters/common.ts";
import { replaceStoredApiKey, type CredentialStoreOptions } from "./credentials.ts";
import { joinEndpointUrl, requestJson } from "./http.ts";
import type {
  AdapterProtocol,
  EndpointAuth,
  EndpointConfig,
  MediaKind,
  ResolvedEndpoint,
  RouteConfig,
} from "./types.ts";
import { isRecord, sha256 } from "./utils.ts";

const MAX_MODEL_PAGES = 20;

export interface DiscoveredModel {
  id: string;
  displayName?: string;
}

export interface DiscoverModelsOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SaveSetupInput extends CredentialStoreOptions {
  targetPath: string;
  baseRoutes: RouteConfig;
  endpointId: string;
  protocol: AdapterProtocol;
  baseUrl: string;
  model: string;
  modalities: MediaKind[];
  apiKey?: string;
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export function defaultBaseUrl(protocol: AdapterProtocol): string {
  if (protocol === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  if (protocol === "anthropic-messages") return "https://api.anthropic.com/v1";
  return "https://api.openai.com/v1";
}

export function protocolModalities(protocol: AdapterProtocol): MediaKind[] {
  return [...PROTOCOL_KINDS[protocol]];
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError("API URL 无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SetupError("API URL 必须使用 http 或 https");
  if (url.username || url.password) throw new SetupError("API URL 不能包含用户名或密码");
  if (url.search || url.hash) throw new SetupError("API URL 不能包含查询参数或片段");
  return url.toString().replace(/\/+$/, "");
}

function setupEndpoint(protocol: AdapterProtocol, baseUrl: string, options: DiscoverModelsOptions): ResolvedEndpoint {
  const config: EndpointConfig = {
    protocol,
    baseUrl,
    model: "model-discovery",
    modalities: protocolModalities(protocol),
    auth: { type: "none" },
    headers: {},
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBytes: 1,
    maxInlineBytes: 1,
    maxOutputTokens: 1,
    fullMaxOutputTokens: 1,
    maxTokensField: "max_completion_tokens",
    geminiVariant: "generate-content",
  };
  return {
    id: "setup",
    config,
    baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    headers: { ...options.headers },
  };
}

function modelListUrl(endpoint: ResolvedEndpoint, query: Record<string, string> = {}): string {
  const version = endpoint.config.protocol === "gemini" ? "v1beta" : "v1";
  const url = new URL(joinEndpointUrl(endpoint.baseUrl, defaultApiPath(endpoint, version, "models")));
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

function discoveryHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
  if (endpoint.config.protocol === "anthropic-messages") return anthropicHeaders(endpoint);
  if (endpoint.config.protocol === "gemini") return geminiHeaders(endpoint);
  return openAIHeaders(endpoint);
}

async function getModelPage(
  endpoint: ResolvedEndpoint,
  query: Record<string, string>,
  options: DiscoverModelsOptions,
): Promise<unknown> {
  return requestJson(
    modelListUrl(endpoint, query),
    () => ({ method: "GET", headers: discoveryHeaders(endpoint) }),
    {
      timeoutMs: endpoint.config.timeoutMs,
      retries: 1,
      ...(options.signal ? { signal: options.signal } : {}),
      secrets: requestSecrets(endpoint),
    },
  );
}

function parseOpenAIModels(value: unknown): DiscoveredModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new SetupError("模型列表响应缺少 data 数组");
  return value.data.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" && item.id.trim() ? [{ id: item.id.trim() }] : [],
  );
}

async function discoverAnthropicModels(
  endpoint: ResolvedEndpoint,
  options: DiscoverModelsOptions,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let afterId: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const value = await getModelPage(endpoint, { limit: "1000", ...(afterId ? { after_id: afterId } : {}) }, options);
    if (!isRecord(value) || !Array.isArray(value.data)) throw new SetupError("Anthropic 模型列表响应缺少 data 数组");
    for (const item of value.data) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
      models.push({
        id: item.id.trim(),
        ...(typeof item.display_name === "string" && item.display_name.trim()
          ? { displayName: item.display_name.trim() }
          : {}),
      });
    }
    if (value.has_more !== true) break;
    if (page === MAX_MODEL_PAGES - 1) throw new SetupError("Anthropic 模型列表分页过多");
    const lastId = typeof value.last_id === "string" ? value.last_id : models.at(-1)?.id;
    if (!lastId || seen.has(lastId)) throw new SetupError("Anthropic 模型分页游标无效");
    seen.add(lastId);
    afterId = lastId;
  }
  return models;
}

async function discoverGeminiModels(
  endpoint: ResolvedEndpoint,
  options: DiscoverModelsOptions,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const value = await getModelPage(endpoint, { pageSize: "1000", ...(pageToken ? { pageToken } : {}) }, options);
    if (!isRecord(value) || !Array.isArray(value.models)) throw new SetupError("Gemini 模型列表响应缺少 models 数组");
    for (const item of value.models) {
      if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) continue;
      if (
        Array.isArray(item.supportedGenerationMethods) &&
        !item.supportedGenerationMethods.includes("generateContent")
      ) {
        continue;
      }
      models.push({
        id: item.name.trim().replace(/^models\//, ""),
        ...(typeof item.displayName === "string" && item.displayName.trim()
          ? { displayName: item.displayName.trim() }
          : {}),
      });
    }
    const nextToken = typeof value.nextPageToken === "string" && value.nextPageToken ? value.nextPageToken : undefined;
    if (!nextToken) break;
    if (page === MAX_MODEL_PAGES - 1) throw new SetupError("Gemini 模型列表分页过多");
    if (seen.has(nextToken)) throw new SetupError("Gemini 模型分页令牌无效");
    seen.add(nextToken);
    pageToken = nextToken;
  }
  return models;
}

export async function discoverModels(
  protocol: AdapterProtocol,
  baseUrl: string,
  options: DiscoverModelsOptions = {},
): Promise<DiscoveredModel[]> {
  const endpoint = setupEndpoint(protocol, normalizeBaseUrl(baseUrl), options);
  let models: DiscoveredModel[];
  if (protocol === "anthropic-messages") models = await discoverAnthropicModels(endpoint, options);
  else if (protocol === "gemini") models = await discoverGeminiModels(endpoint, options);
  else models = parseOpenAIModels(await getModelPage(endpoint, {}, options));

  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function readConfigObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new SetupError(`配置文件根节点必须是对象：${path}`);
    return value;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") return {};
    if (error instanceof SetupError) throw error;
    throw new SetupError(`无法读取配置文件：${path}`);
  }
}

async function writeConfigObject(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function credentialId(targetPath: string, endpointId: string): string {
  const resolvedPath = resolve(targetPath);
  const canonicalPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  return `endpoint:${sha256(`${canonicalPath}\n${endpointId}`).slice(0, 24)}`;
}

export async function saveSetup(input: SaveSetupInput): Promise<{ credentialId?: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(input.endpointId)) {
    throw new SetupError("端点 ID 只能包含字母、数字、点、下划线和连字符");
  }
  if (!input.model.trim()) throw new SetupError("模型 ID 不能为空");
  if (input.apiKey !== undefined && !input.apiKey) throw new SetupError("API Key 不能为空");
  const supported = new Set(protocolModalities(input.protocol));
  if (input.modalities.length === 0 || input.modalities.some((kind) => !supported.has(kind))) {
    throw new SetupError("媒体类型与所选协议不匹配");
  }

  const path = input.targetPath;
  const current = await readConfigObject(path);
  const currentEndpoints = isRecord(current.endpoints) ? current.endpoints : {};
  const generatedCredentialId = credentialId(path, input.endpointId);
  const id = input.apiKey ? generatedCredentialId : undefined;
  const auth: EndpointAuth = id ? { type: "stored", id } : { type: "none" };
  const endpoint: Record<string, unknown> = {
    protocol: input.protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    model: input.model.trim(),
    modalities: [...input.modalities],
    auth,
    ...(input.protocol === "gemini" ? { geminiVariant: "generate-content" } : {}),
  };

  const routes: RouteConfig = { image: [], audio: [], video: [], pdf: [] };
  for (const kind of Object.keys(routes) as MediaKind[]) {
    const withoutEndpoint = input.baseRoutes[kind].filter((routeId) => routeId !== input.endpointId);
    routes[kind] = input.modalities.includes(kind) ? [input.endpointId, ...withoutEndpoint] : withoutEndpoint;
  }
  const next: Record<string, unknown> = {
    ...current,
    version: 1,
    endpoints: { ...currentEndpoints, [input.endpointId]: endpoint },
    routes,
  };

  const credentialOptions: CredentialStoreOptions = input.agentDir ? { agentDir: input.agentDir } : {};
  const previousEndpoint = currentEndpoints[input.endpointId];
  const previousAuth = isRecord(previousEndpoint) && isRecord(previousEndpoint.auth) ? previousEndpoint.auth : undefined;
  const credentialToChange =
    id ?? (previousAuth?.type === "stored" && previousAuth.id === generatedCredentialId ? generatedCredentialId : undefined);
  let previousKey: string | undefined;
  if (credentialToChange) {
    previousKey = await replaceStoredApiKey(credentialToChange, input.apiKey, credentialOptions);
  }
  try {
    await writeConfigObject(path, next);
  } catch (error) {
    if (credentialToChange) {
      await replaceStoredApiKey(credentialToChange, previousKey, credentialOptions).catch(() => undefined);
    }
    throw error;
  }
  return id ? { credentialId: id } : {};
}
