import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readStoredApiKey } from "./credentials.ts";
import type { EndpointConfig, ResolvedEndpoint } from "./types.ts";

export class EndpointAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointAuthError";
  }
}

function expandHeaderValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new EndpointAuthError(`Environment variable ${name} is not set`);
    return resolved;
  });
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

export function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string): void {
  if (!hasHeader(headers, name)) headers[name] = value;
}

export async function resolveEndpoint(
  id: string,
  config: EndpointConfig,
  modelRegistry: ModelRegistry,
): Promise<ResolvedEndpoint> {
  const headers: Record<string, string> = {};
  let apiKey: string | undefined;
  let authBaseUrl: string | undefined;

  if (config.auth.type === "env") {
    apiKey = process.env[config.auth.name];
    if (!apiKey) throw new EndpointAuthError(`Endpoint "${id}" requires environment variable ${config.auth.name}`);
  } else if (config.auth.type === "pi") {
    const result = await modelRegistry.getProviderAuth(config.auth.provider);
    if (!result) throw new EndpointAuthError(`No Pi authentication is configured for provider "${config.auth.provider}"`);
    apiKey = result.auth.apiKey;
    authBaseUrl = result.auth.baseUrl;
    for (const [name, value] of Object.entries(result.auth.headers ?? {})) {
      if (value !== null) headers[name] = value;
    }
  } else if (config.auth.type === "stored") {
    apiKey = await readStoredApiKey(config.auth.id);
    if (!apiKey) throw new EndpointAuthError(`Endpoint "${id}" has no stored API key`);
  }

  for (const [name, value] of Object.entries(config.headers)) headers[name] = expandHeaderValue(value);
  const baseUrl = config.baseUrl ?? authBaseUrl;
  if (!baseUrl) throw new EndpointAuthError(`Endpoint "${id}" requires baseUrl or Pi provider auth with a base URL`);
  try {
    new URL(baseUrl);
  } catch {
    throw new EndpointAuthError(`Endpoint "${id}" has an invalid baseUrl`);
  }

  return {
    id,
    config,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(apiKey ? { apiKey } : {}),
    headers,
  };
}

export function endpointHost(endpoint: ResolvedEndpoint): string {
  return new URL(endpoint.baseUrl).host;
}

export function secretValues(endpoint: ResolvedEndpoint): string[] {
  return [endpoint.apiKey, ...Object.values(endpoint.headers)].filter(
    (value): value is string => typeof value === "string" && value.length >= 6,
  );
}
