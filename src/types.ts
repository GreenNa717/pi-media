export const MEDIA_KINDS = ["image", "audio", "video", "pdf"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];
export type DetailLevel = "task" | "full";
export type AdapterProtocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";
export type GeminiVariant = "generate-content" | "interactions";

export type MediaSource =
  | { type: "file"; path: string }
  | { type: "inline"; data: string };

export interface MediaAsset {
  id: string;
  index: number;
  kind: MediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: MediaSource;
}

export type EndpointAuth =
  | { type: "env"; name: string }
  | { type: "pi"; provider: string }
  | { type: "stored"; id: string }
  | { type: "none" };

export interface EndpointConfig {
  protocol: AdapterProtocol;
  baseUrl?: string;
  path?: string;
  uploadPath?: string;
  model: string;
  modalities: MediaKind[];
  auth: EndpointAuth;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  maxInlineBytes: number;
  maxOutputTokens: number;
  fullMaxOutputTokens: number;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  geminiVariant: GeminiVariant;
}

export type RouteConfig = Record<MediaKind, string[]>;
export type ExtensionConfig = Record<MediaKind, string[]>;

export interface PlannerConfig {
  recentTurns: number;
  maxContextChars: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface PrivacyConfig {
  confirmFirstUpload: boolean;
  rememberConsent: boolean;
  allowNonInteractive: boolean;
}

export interface RouterConfig {
  version: 1;
  endpoints: Record<string, EndpointConfig>;
  routes: RouteConfig;
  extensions: ExtensionConfig;
  planner: PlannerConfig;
  privacy: PrivacyConfig;
  concurrency: number;
}

export interface AssetFocus {
  assetId: string;
  focus: string;
}

export interface AnalysisPlan {
  objective: string;
  instructions: string[];
  outputLanguage: string;
  detail: DetailLevel;
  includeTimestamps: boolean;
  assetFocus: AssetFocus[];
}

export interface MediaReport {
  endpointId: string;
  protocol: AdapterProtocol;
  model: string;
  assetIds: string[];
  text: string;
  warnings: string[];
}

export interface ResolvedEndpoint {
  id: string;
  config: EndpointConfig;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
}

export interface AdapterRequest {
  endpoint: ResolvedEndpoint;
  assets: MediaAsset[];
  plan: AnalysisPlan;
  signal?: AbortSignal;
}

export interface ProtocolAdapter {
  protocol: AdapterProtocol;
  supportedKinds: readonly MediaKind[];
  analyze(request: AdapterRequest): Promise<MediaReport>;
  probe(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<string>;
}

export interface RouteRequest {
  assets: MediaAsset[];
  plan: AnalysisPlan;
  config: RouterConfig;
  endpointOverride?: string;
  signal?: AbortSignal;
}

export interface ParsedMediaInput {
  assets: MediaAsset[];
  cleanedText: string;
  missingReferences: string[];
}
