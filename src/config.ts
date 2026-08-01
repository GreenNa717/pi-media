import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  MEDIA_KINDS,
  type AdapterProtocol,
  type EndpointAuth,
  type EndpointConfig,
  type ExtensionConfig,
  type GeminiVariant,
  type MediaKind,
  type PrivacyConfig,
  type RouteConfig,
  type RouterConfig,
} from "./types.ts";
import { isRecord } from "./utils.ts";

const PROTOCOLS: readonly AdapterProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini",
  "custom-openai-chat",
];

export const DEFAULT_EXTENSIONS: ExtensionConfig = {
  image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac"],
  video: [".mp4", ".m4v", ".mov", ".mpeg", ".mpg", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".3gp", ".3gpp"],
  pdf: [".pdf"],
};

export const DEFAULT_CONFIG: RouterConfig = {
  version: 1,
  endpoints: {},
  routes: { image: [], audio: [], video: [], pdf: [] },
  extensions: DEFAULT_EXTENSIONS,
  planner: {
    recentTurns: 6,
    maxContextChars: 24_000,
    timeoutMs: 120_000,
    maxOutputTokens: 2_048,
  },
  privacy: {
    confirmFirstUpload: true,
    rememberConsent: true,
    allowNonInteractive: false,
  },
  concurrency: 2,
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  agentDir?: string;
  configDirName?: string;
}

export interface LoadedConfig {
  config: RouterConfig;
  globalPath: string;
  projectPath: string;
  loadedPaths: string[];
}

export interface LoadedGlobalConfig {
  config: RouterConfig;
  globalPath: string;
  loadedPaths: string[];
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${key} must be a non-empty string`);
  return value;
}

function optionalApiKeyHeader(record: Record<string, unknown>, fallback?: string): string | undefined {
  const value = record.apiKeyHeader ?? fallback;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    throw new ConfigError("apiKeyHeader must be a valid HTTP header name");
  }
  return value;
}

function optionalApiKeyPrefix(record: Record<string, unknown>, fallback?: string): string | undefined {
  const value = record.apiKeyPrefix ?? fallback;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConfigError("apiKeyPrefix must be a string without control characters");
  }
  return value;
}

function positiveNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive number`);
  }
  return value;
}

function positiveInteger(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = positiveNumber(record, key, fallback);
  if (!Number.isInteger(value)) throw new ConfigError(`${key} must be a positive integer`);
  return value;
}

function booleanValue(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${key} must be a boolean`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ConfigError(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item));
}

function parseAuth(value: unknown, label: string, fallback?: EndpointAuth): EndpointAuth {
  if (value === undefined && fallback) return fallback;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ConfigError(`${label} must contain an auth type`);
  }
  if (value.type === "none") return { type: "none" };
  if (value.type === "env" && typeof value.name === "string" && value.name.trim()) {
    return { type: "env", name: value.name };
  }
  if (value.type === "pi" && typeof value.provider === "string" && value.provider.trim()) {
    return { type: "pi", provider: value.provider };
  }
  if (value.type === "stored" && typeof value.id === "string" && value.id.trim()) {
    return { type: "stored", id: value.id };
  }
  throw new ConfigError(`${label} must be {type:env,name}, {type:pi,provider}, {type:stored,id}, or {type:none}`);
}

function parseHeaders(value: unknown, label: string, fallback: Record<string, string>): Record<string, string> {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object`);
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") throw new ConfigError(`${label}.${key} must be a string`);
    headers[key] = headerValue;
  }
  return headers;
}

function endpointDefaults(protocol: AdapterProtocol): Pick<EndpointConfig, "timeoutMs" | "maxBytes" | "maxInlineBytes"> {
  if (protocol === "gemini") {
    return { timeoutMs: 600_000, maxBytes: 512 * 1024 * 1024, maxInlineBytes: 20 * 1024 * 1024 };
  }
  if (protocol === "custom-openai-chat") {
    return { timeoutMs: 180_000, maxBytes: 37 * 1024 * 1024, maxInlineBytes: 37 * 1024 * 1024 };
  }
  return { timeoutMs: 180_000, maxBytes: 20 * 1024 * 1024, maxInlineBytes: 20 * 1024 * 1024 };
}

function parseEndpoint(id: string, value: unknown, fallback?: EndpointConfig): EndpointConfig {
  if (!isRecord(value)) throw new ConfigError(`endpoints.${id} must be an object`);
  const protocolValue = value.protocol ?? fallback?.protocol;
  if (typeof protocolValue !== "string" || !PROTOCOLS.includes(protocolValue as AdapterProtocol)) {
    throw new ConfigError(`endpoints.${id}.protocol is invalid`);
  }
  const protocol = protocolValue as AdapterProtocol;
  const defaults = endpointDefaults(protocol);
  const model = value.model ?? fallback?.model;
  if (typeof model !== "string" || !model.trim()) throw new ConfigError(`endpoints.${id}.model is required`);

  const modalitiesValue = value.modalities ?? fallback?.modalities;
  const modalities = stringArray(modalitiesValue, `endpoints.${id}.modalities`);
  if (modalities.some((kind) => !MEDIA_KINDS.includes(kind as MediaKind))) {
    throw new ConfigError(`endpoints.${id}.modalities contains an unsupported media kind`);
  }

  const maxTokensFieldValue = value.maxTokensField ?? fallback?.maxTokensField ?? "max_completion_tokens";
  if (maxTokensFieldValue !== "max_tokens" && maxTokensFieldValue !== "max_completion_tokens") {
    throw new ConfigError(`endpoints.${id}.maxTokensField is invalid`);
  }
  const geminiVariantValue = value.geminiVariant ?? fallback?.geminiVariant ?? "generate-content";
  if (geminiVariantValue !== "generate-content" && geminiVariantValue !== "interactions") {
    throw new ConfigError(`endpoints.${id}.geminiVariant is invalid`);
  }

  const baseUrl = optionalString(value, "baseUrl") ?? fallback?.baseUrl;
  const path = optionalString(value, "path") ?? fallback?.path;
  const streamPath = optionalString(value, "streamPath") ?? fallback?.streamPath;
  const uploadPath = optionalString(value, "uploadPath") ?? fallback?.uploadPath;
  const apiKeyHeader = optionalApiKeyHeader(value, fallback?.apiKeyHeader);
  const apiKeyPrefix = optionalApiKeyPrefix(value, fallback?.apiKeyPrefix);
  return {
    protocol,
    ...(baseUrl ? { baseUrl } : {}),
    ...(path ? { path } : {}),
    ...(streamPath ? { streamPath } : {}),
    ...(uploadPath ? { uploadPath } : {}),
    ...(apiKeyHeader ? { apiKeyHeader } : {}),
    ...(apiKeyPrefix !== undefined ? { apiKeyPrefix } : {}),
    model,
    modalities: modalities as MediaKind[],
    auth: parseAuth(value.auth, `endpoints.${id}.auth`, fallback?.auth),
    headers: parseHeaders(value.headers, `endpoints.${id}.headers`, fallback?.headers ?? {}),
    timeoutMs: positiveNumber(value, "timeoutMs", fallback?.timeoutMs ?? defaults.timeoutMs),
    maxBytes: positiveNumber(value, "maxBytes", fallback?.maxBytes ?? defaults.maxBytes),
    maxInlineBytes: positiveNumber(value, "maxInlineBytes", fallback?.maxInlineBytes ?? defaults.maxInlineBytes),
    maxOutputTokens: positiveNumber(value, "maxOutputTokens", fallback?.maxOutputTokens ?? 4_096),
    fullMaxOutputTokens: positiveNumber(value, "fullMaxOutputTokens", fallback?.fullMaxOutputTokens ?? 16_384),
    maxTokensField: maxTokensFieldValue,
    geminiVariant: geminiVariantValue as GeminiVariant,
  };
}

function parseKindMap(
  value: unknown,
  label: string,
  fallback: Record<MediaKind, string[]>,
  normalizeExtension: boolean,
): Record<MediaKind, string[]> {
  if (value === undefined) return Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, [...fallback[kind]]])) as Record<MediaKind, string[]>;
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object`);
  const result = {} as Record<MediaKind, string[]>;
  for (const kind of MEDIA_KINDS) {
    const raw = value[kind];
    const items = raw === undefined ? fallback[kind] : stringArray(raw, `${label}.${kind}`);
    result[kind] = normalizeExtension
      ? items.map((item) => (item.startsWith(".") ? item.toLowerCase() : `.${item.toLowerCase()}`))
      : [...items];
  }
  return result;
}

function parseConfig(value: unknown, base: RouterConfig): RouterConfig {
  if (!isRecord(value)) throw new ConfigError("Configuration root must be an object");
  if (value.version !== undefined && value.version !== 1) throw new ConfigError("Only configuration version 1 is supported");

  const endpoints = { ...base.endpoints };
  if (value.endpoints !== undefined) {
    if (!isRecord(value.endpoints)) throw new ConfigError("endpoints must be an object");
    for (const [id, endpoint] of Object.entries(value.endpoints)) {
      if (!id.trim()) throw new ConfigError("Endpoint IDs cannot be empty");
      endpoints[id] = parseEndpoint(id, endpoint, endpoints[id]);
    }
  }

  const plannerValue = value.planner;
  if (plannerValue !== undefined && !isRecord(plannerValue)) throw new ConfigError("planner must be an object");
  const planner = plannerValue ?? {};
  const privacyValue = value.privacy;
  if (privacyValue !== undefined && !isRecord(privacyValue)) throw new ConfigError("privacy must be an object");
  const privacy = privacyValue ?? {};

  return {
    version: 1,
    endpoints,
    routes: parseKindMap(value.routes, "routes", base.routes, false) as RouteConfig,
    extensions: parseKindMap(value.extensions, "extensions", base.extensions, true) as ExtensionConfig,
    planner: {
      recentTurns: positiveInteger(planner, "recentTurns", base.planner.recentTurns),
      maxContextChars: positiveInteger(planner, "maxContextChars", base.planner.maxContextChars),
      timeoutMs: positiveNumber(planner, "timeoutMs", base.planner.timeoutMs),
      maxOutputTokens: positiveInteger(planner, "maxOutputTokens", base.planner.maxOutputTokens),
    },
    privacy: {
      confirmFirstUpload: booleanValue(privacy, "confirmFirstUpload", base.privacy.confirmFirstUpload),
      rememberConsent: booleanValue(privacy, "rememberConsent", base.privacy.rememberConsent),
      allowNonInteractive: booleanValue(privacy, "allowNonInteractive", base.privacy.allowNonInteractive),
    } satisfies PrivacyConfig,
    concurrency: positiveInteger(value, "concurrency", base.concurrency),
  };
}

async function readConfigFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Could not read ${path}: ${message}`);
  }
}

export async function loadGlobalRouterConfig(options: LoadConfigOptions = {}): Promise<LoadedGlobalConfig> {
  const agentDir = options.agentDir ?? getAgentDir();
  const globalPath = join(agentDir, "media-router.json");
  const loadedPaths: string[] = [];
  let config = parseConfig({}, DEFAULT_CONFIG);
  const globalValue = await readConfigFile(globalPath);
  if (globalValue !== undefined) {
    config = parseConfig(globalValue, config);
    loadedPaths.push(globalPath);
  }
  return { config, globalPath, loadedPaths };
}

export async function loadRouterConfig(cwd: string, options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const global = await loadGlobalRouterConfig(options);
  const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
  const projectPath = join(cwd, configDirName, "media-router.json");
  const loadedPaths = [...global.loadedPaths];
  let config = global.config;
  const projectValue = await readConfigFile(projectPath);
  if (projectValue !== undefined) {
    config = parseConfig(projectValue, config);
    loadedPaths.push(projectPath);
  }

  validateRoutes(config);
  return { config, globalPath: global.globalPath, projectPath, loadedPaths };
}

export function validateRoutes(config: RouterConfig): void {
  for (const kind of MEDIA_KINDS) {
    for (const endpointId of config.routes[kind]) {
      const endpoint = config.endpoints[endpointId];
      if (!endpoint) throw new ConfigError(`routes.${kind} references unknown endpoint "${endpointId}"`);
      if (!endpoint.modalities.includes(kind)) {
        throw new ConfigError(`routes.${kind} references endpoint "${endpointId}" without ${kind} capability`);
      }
    }
  }
}
