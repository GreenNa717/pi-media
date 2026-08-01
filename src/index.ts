import { randomBytes } from "node:crypto";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { handleMediaCommand, type MediaCommandRuntime } from "./command.ts";
import { DEFAULT_EXTENSIONS, loadRouterConfig } from "./config.ts";
import { analyzeMediaAssets, processMedia } from "./pipeline.ts";
import {
  appendEvidenceToUserMessage,
  formatToolEvidence,
  formatUntrustedEvidence,
  isMediaReportCardData,
  mediaIdsFromText,
  REPORT_ENTRY_TYPE,
  reportCardData,
  sanitizeDisplayText,
  userMessageText,
  type MediaReportCardData,
} from "./presentation.ts";
import { MediaProgressPanel } from "./progress.ts";
import { MediaSessionRegistry } from "./registry.ts";
import { RouteError } from "./router.ts";
import type { DetailLevel, MediaAsset, MediaProgressEvent, MediaReport } from "./types.ts";

const MEDIA_EXTENSIONS = [...new Set(Object.values(DEFAULT_EXTENSIONS).flat())];
const MediaQueryParameters = Type.Object({
  assetIds: Type.Array(Type.String({ pattern: "^media_[a-f0-9]{24}$" }), {
    minItems: 1,
    maxItems: 8,
    description: "Media IDs shown in the conversation. Paths and URLs are not accepted.",
  }),
  question: Type.String({
    minLength: 1,
    maxLength: 8_000,
    description: "A self-contained question describing exactly what to inspect in the original media.",
  }),
  detail: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("full")])),
});

interface MediaQueryDetails {
  status: "running" | "complete" | "error";
  assetIds: string[];
  endpoint?: string;
  model?: string;
  text?: string;
  error?: string;
}

function likelyContainsMedia(text: string, imageCount: number): boolean {
  if (imageCount > 0) return true;
  const lowerText = text.toLowerCase();
  return MEDIA_EXTENSIONS.some((extension) => lowerText.includes(extension));
}

function errorMessage(error: unknown): string {
  if (error instanceof RouteError && error.diagnostics.length) {
    return `${error.message}\n${error.diagnostics.map((item) => `- ${item}`).join("\n")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function uniqueCards(cards: readonly MediaReportCardData[]): MediaReportCardData[] {
  const byId = new Map(cards.map((card) => [card.reportId, card]));
  return [...byId.values()];
}

export default function mediaRouterExtension(pi: ExtensionAPI): void {
  const registry = new MediaSessionRegistry();
  const progressPanel = new MediaProgressPanel();
  const cardsByAsset = new Map<string, MediaReportCardData[]>();
  const appendedCards = new Set<string>();

  const addCard = (card: MediaReportCardData): void => {
    for (const source of card.sources) {
      const cards = cardsByAsset.get(source.id) ?? [];
      if (!cards.some((item) => item.reportId === card.reportId)) cards.push(card);
      cardsByAsset.set(source.id, cards);
    }
  };

  const rememberReports = (assets: readonly MediaAsset[], reports: readonly MediaReport[]): void => {
    for (const report of reports) {
      const id = `report_${randomBytes(12).toString("hex")}`;
      addCard(reportCardData(id, assets, report));
    }
  };

  const reconstructReports = (ctx: ExtensionContext): void => {
    cardsByAsset.clear();
    appendedCards.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== REPORT_ENTRY_TYPE || !isMediaReportCardData(entry.data)) continue;
      addCard(entry.data);
      appendedCards.add(entry.data.reportId);
    }
  };

  const runtime: MediaCommandRuntime = {
    registry,
    onProgress: (event, ctx) => progressPanel.handle(event, ctx.ui),
    onReports: rememberReports,
    clearProgress: (ctx) => progressPanel.clear(ctx.ui),
  };

  pi.registerEntryRenderer<MediaReportCardData>(REPORT_ENTRY_TYPE, (entry, _options, theme) => {
    if (!isMediaReportCardData(entry.data)) return undefined;
    const data = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const title = theme.fg("accent", theme.bold(`多模态模型 · ${data.report.endpointId}/${data.report.model}`));
    const sources = data.sources.map((source) => `${source.name} · ${source.kind} · ${source.id}`).join("\n");
    const warnings = data.report.warnings.length
      ? `\n\n${theme.fg("warning", sanitizeDisplayText(data.report.warnings.join("; ")))}`
      : "";
    box.addChild(new Text(`${title}\n${theme.fg("dim", sanitizeDisplayText(sources))}\n\n${sanitizeDisplayText(data.report.text)}${warnings}`, 0, 0));
    return box;
  });

  pi.registerTool({
    name: "media_query",
    label: "Media query",
    description: "Ask a focused follow-up question about media already sent in this Pi session. Use only listed media IDs. The question must be self-contained.",
    promptSnippet: "Query previously sent media again by media ID when the existing report is insufficient.",
    promptGuidelines: [
      "Use media_query when an existing media report lacks the detail needed to answer the user.",
      "media_query questions must be self-contained and must not contain file paths or endpoint addresses.",
    ],
    parameters: MediaQueryParameters,
    executionMode: "sequential",
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const assetIds = [...params.assetIds];
      let streamedText = "";
      const update = (event: MediaProgressEvent): void => {
        progressPanel.handle(event, ctx.ui);
        if (event.phase === "start") streamedText = "";
        else if (event.phase === "delta") streamedText += sanitizeDisplayText(event.delta ?? "");
        else if (event.phase === "complete") streamedText = sanitizeDisplayText(event.text ?? streamedText);
        else if (event.message) streamedText = sanitizeDisplayText(event.message);
        if (streamedText.length > 64_000) streamedText = streamedText.slice(-64_000);
        const text = streamedText || event.phase;
        onUpdate?.({
          content: [{ type: "text", text: text.slice(-4_000) }],
          details: {
            status: "running",
            assetIds,
            endpoint: event.endpointId,
            model: event.model,
            text: text.slice(-4_000),
          } satisfies MediaQueryDetails,
        });
      };

      try {
        const assets = await registry.resolve(assetIds);
        const loaded = await loadRouterConfig(ctx.cwd);
        const reports = await analyzeMediaAssets(ctx, assets, params.question.trim(), loaded.config, {
          detail: (params.detail ?? "task") as DetailLevel,
          onProgress: update,
          ...(signal ? { signal } : {}),
        });
        const evidence = formatToolEvidence(assets, reports);
        const endpoint = [...new Set(reports.map((report) => report.endpointId))].join(", ");
        const model = [...new Set(reports.map((report) => report.model))].join(", ");
        return {
          content: [{ type: "text", text: evidence }],
          details: { status: "complete", assetIds, endpoint, model, text: evidence } satisfies MediaQueryDetails,
        };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: "text", text: `media_query failed: ${message}` }],
          details: { status: "error", assetIds, error: message } satisfies MediaQueryDetails,
          isError: true,
        };
      } finally {
        ctx.ui.setStatus("media-router", undefined);
        progressPanel.clear(ctx.ui);
      }
    },
    renderCall(args, theme) {
      const ids = args.assetIds.join(", ");
      return new Text(`${theme.fg("toolTitle", theme.bold("多模态追问"))} ${theme.fg("dim", ids)}\n${sanitizeDisplayText(args.question)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as MediaQueryDetails | undefined;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      if (isPartial) {
        box.addChild(new Text(`${theme.fg("accent", "多模态模型 · 实时分析")}\n${sanitizeDisplayText(details?.text ?? "Connecting...")}`, 0, 0));
        return box;
      }
      if (!details || details.status === "error") {
        box.addChild(new Text(theme.fg("error", sanitizeDisplayText(details?.error ?? "media_query failed")), 0, 0));
        return box;
      }
      const title = theme.fg("accent", theme.bold(`多模态模型 · ${details.endpoint}/${details.model}`));
      box.addChild(new Text(`${title}\n\n${sanitizeDisplayText(details.text ?? "")}`, 0, 0));
      return box;
    },
  });

  pi.registerCommand("media", {
    description: "Analyze image, audio, video, or PDF files through configured multimodal endpoints",
    handler: async (args, ctx) => handleMediaCommand(pi, args, ctx, runtime),
  });

  pi.on("session_start", async (_event, ctx) => {
    registry.clear();
    reconstructReports(ctx);
    progressPanel.clear(ctx.ui);
  });
  pi.on("session_tree", async (_event, ctx) => {
    registry.clear();
    reconstructReports(ctx);
    progressPanel.clear(ctx.ui);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    registry.clear();
    cardsByAsset.clear();
    appendedCards.clear();
    progressPanel.clear(ctx.ui);
  });

  pi.on("before_agent_start", async (event) => {
    const available = registry.descriptors();
    if (available.length === 0) return undefined;
    const inventory = available.map((asset) => `- ${asset.id}: ${asset.name} (${asset.kind}, ${asset.mimeType})`).join("\n");
    return {
      systemPrompt: `${event.systemPrompt}\n\nMedia Router session media:\n${inventory}\nUse media_query when the existing media report is insufficient. Ask one self-contained question and use only the listed IDs. Never invent media IDs, paths, or endpoint addresses.`,
    };
  });

  pi.on("context", async (event) => {
    const messages: typeof event.messages = [];
    for (const message of event.messages) {
      if (message.role !== "user") {
        messages.push(message);
        continue;
      }
      const ids = mediaIdsFromText(userMessageText(message as UserMessage));
      const cards = uniqueCards(ids.flatMap((id) => cardsByAsset.get(id) ?? []));
      if (cards.length === 0) {
        messages.push(message);
        continue;
      }
      for (const card of cards) {
        if (appendedCards.has(card.reportId)) continue;
        pi.appendEntry(REPORT_ENTRY_TYPE, card);
        appendedCards.add(card.reportId);
      }
      messages.push(appendEvidenceToUserMessage(message as UserMessage, formatUntrustedEvidence(cards)));
    }
    return { messages };
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!likelyContainsMedia(event.text, event.images?.length ?? 0)) return { action: "continue" };

    try {
      const loaded = await loadRouterConfig(ctx.cwd);
      const result = await processMedia(ctx, event.text, event.images, loaded.config, {
        registry,
        onProgress: (progress) => progressPanel.handle(progress, ctx.ui),
      });
      if (!result) return { action: "continue" };
      rememberReports(result.routedAssets, result.reports);
      return { action: "transform", text: result.text, images: result.images };
    } catch (error) {
      const message = errorMessage(error);
      ctx.ui.notify(`Media Router: ${message}`, "error");
      if (ctx.hasUI && event.streamingBehavior === undefined) ctx.ui.setEditorText(event.text);
      if (!ctx.hasUI) console.error(`Media Router: ${message}`);
      return { action: "handled" };
    } finally {
      ctx.ui.setStatus("media-router", undefined);
      progressPanel.clear(ctx.ui);
    }
  });
}

export * from "./types.ts";
export { loadGlobalRouterConfig, loadRouterConfig, validateRoutes } from "./config.ts";
export { inspectMediaFile, parseMediaInput } from "./media.ts";
export { createAnalysisPlan, buildPlannerContext } from "./planner.ts";
export { MediaSessionRegistry } from "./registry.ts";
export { routeMedia } from "./router.ts";
export { defaultBaseUrl, discoverModels, normalizeBaseUrl, protocolModalities, saveSetup } from "./setup.ts";
