import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADAPTERS } from "./adapters/index.ts";
import { resolveEndpoint } from "./auth.ts";
import type { LoadedConfig } from "./config.ts";

export interface DoctorResult {
  ok: boolean;
  lines: string[];
}

export async function runDoctor(ctx: ExtensionContext, loaded: LoadedConfig, probe: boolean): Promise<DoctorResult> {
  const lines: string[] = [];
  let ok = true;
  lines.push(`Config: ${loaded.loadedPaths.length ? loaded.loadedPaths.join(", ") : "defaults only"}`);

  const entries = Object.entries(loaded.config.endpoints);
  if (entries.length === 0) {
    return { ok: false, lines: [...lines, "ERROR: no endpoints are configured"] };
  }

  for (const [id, endpointConfig] of entries) {
    const adapter = ADAPTERS.get(endpointConfig.protocol);
    if (!adapter) {
      ok = false;
      lines.push(`ERROR ${id}: adapter ${endpointConfig.protocol} is unavailable`);
      continue;
    }
    const invalidKinds = endpointConfig.modalities.filter((kind) => !adapter.supportedKinds.includes(kind));
    if (invalidKinds.length) {
      ok = false;
      lines.push(`ERROR ${id}: ${endpointConfig.protocol} has no official blocks for ${invalidKinds.join(", ")}`);
      continue;
    }
    try {
      const endpoint = await resolveEndpoint(id, endpointConfig, ctx.modelRegistry);
      lines.push(`OK ${id}: ${endpointConfig.protocol}, ${new URL(endpoint.baseUrl).host}, ${endpointConfig.modalities.join(", ")}`);
      if (probe) {
        const response = await adapter.probe(endpoint, ctx.signal);
        if (response.trim() === "media-router-ok") {
          lines.push(`PROBE ${id}: ok`);
        } else {
          ok = false;
          lines.push(`PROBE ${id}: unexpected response: ${response.slice(0, 80)}`);
        }
      }
    } catch (error) {
      ok = false;
      lines.push(`ERROR ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const [kind, route] of Object.entries(loaded.config.routes)) {
    lines.push(`ROUTE ${kind}: ${route.length ? route.join(" -> ") : "not configured"}`);
  }
  return { ok, lines };
}
