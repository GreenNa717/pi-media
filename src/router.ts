import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveEndpoint } from "./auth.ts";
import { ADAPTERS } from "./adapters/index.ts";
import type {
  MediaAsset,
  MediaKind,
  MediaReport,
  ProtocolAdapter,
  ResolvedEndpoint,
  RouteRequest,
  RouterConfig,
} from "./types.ts";
import { mapLimit, truncate } from "./utils.ts";

export class RouteError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: string[] = []) {
    super(message);
    this.name = "RouteError";
    this.diagnostics = diagnostics;
  }
}

export function candidateEndpointIds(
  assets: readonly MediaAsset[],
  config: RouterConfig,
  endpointOverride?: string,
): string[] {
  if (endpointOverride) return [endpointOverride];
  const ids = new Set<string>();
  for (const asset of assets) for (const id of config.routes[asset.kind]) ids.add(id);
  return [...ids];
}

export async function resolveCandidateEndpoints(
  assets: readonly MediaAsset[],
  config: RouterConfig,
  modelRegistry: ModelRegistry,
  endpointOverride?: string,
): Promise<ResolvedEndpoint[]> {
  const results: ResolvedEndpoint[] = [];
  for (const id of candidateEndpointIds(assets, config, endpointOverride)) {
    const endpoint = config.endpoints[id];
    if (!endpoint) throw new RouteError(`Unknown endpoint "${id}"`);
    results.push(await resolveEndpoint(id, endpoint, modelRegistry));
  }
  return results;
}

interface AssetGroup {
  kind: MediaKind;
  assets: MediaAsset[];
}

function groupAssets(assets: readonly MediaAsset[]): AssetGroup[] {
  const groups = new Map<MediaKind, MediaAsset[]>();
  for (const asset of assets) {
    const group = groups.get(asset.kind) ?? [];
    group.push(asset);
    groups.set(asset.kind, group);
  }
  return [...groups].map(([kind, groupedAssets]) => ({ kind, assets: groupedAssets }));
}

export async function routeMedia(
  request: RouteRequest,
  modelRegistry: ModelRegistry,
  adapters: ReadonlyMap<string, ProtocolAdapter> = ADAPTERS,
): Promise<MediaReport[]> {
  const groups = groupAssets(request.assets);
  const reports = await mapLimit(groups, request.config.concurrency, async (group) => {
    const endpointIds = request.endpointOverride ? [request.endpointOverride] : request.config.routes[group.kind];
    if (endpointIds.length === 0) throw new RouteError(`No endpoint route is configured for ${group.kind}`);
    const diagnostics: string[] = [];

    for (const endpointId of endpointIds) {
      const endpointConfig = request.config.endpoints[endpointId];
      if (!endpointConfig) {
        diagnostics.push(`${endpointId}: endpoint is not configured`);
        continue;
      }
      if (!endpointConfig.modalities.includes(group.kind)) {
        diagnostics.push(`${endpointId}: endpoint does not declare ${group.kind}`);
        continue;
      }
      const adapter = adapters.get(endpointConfig.protocol);
      if (!adapter) {
        diagnostics.push(`${endpointId}: adapter ${endpointConfig.protocol} is unavailable`);
        continue;
      }
      if (!adapter.supportedKinds.includes(group.kind)) {
        diagnostics.push(`${endpointId}: ${endpointConfig.protocol} has no official ${group.kind} content block`);
        continue;
      }

      try {
        const endpoint = await resolveEndpoint(endpointId, endpointConfig, modelRegistry);
        request.onProgress?.({
          phase: "start",
          endpointId,
          protocol: endpointConfig.protocol,
          model: endpointConfig.model,
          assetIds: group.assets.map((asset) => asset.id),
          assetNames: group.assets.map((asset) => asset.name),
        });
        const report = await adapter.analyze({
          endpoint,
          assets: group.assets,
          plan: request.plan,
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        });
        request.onProgress?.({
          phase: "complete",
          endpointId,
          protocol: endpointConfig.protocol,
          model: endpointConfig.model,
          assetIds: group.assets.map((asset) => asset.id),
          assetNames: group.assets.map((asset) => asset.name),
          text: report.text,
        });
        return report;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.onProgress?.({
          phase: "error",
          endpointId,
          protocol: endpointConfig.protocol,
          model: endpointConfig.model,
          assetIds: group.assets.map((asset) => asset.id),
          assetNames: group.assets.map((asset) => asset.name),
          message: truncate(message, 400),
        });
        diagnostics.push(`${endpointId}: ${truncate(message, 400)}`);
      }
    }

    throw new RouteError(`All endpoints failed for ${group.kind}`, diagnostics);
  });

  return reports.sort((left, right) => {
    const leftIndex = Math.min(...left.assetIds.map((id) => request.assets.find((asset) => asset.id === id)?.index ?? Infinity));
    const rightIndex = Math.min(...right.assetIds.map((id) => request.assets.find((asset) => asset.id === id)?.index ?? Infinity));
    return leftIndex - rightIndex;
  });
}
