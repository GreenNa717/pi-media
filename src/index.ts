import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleMediaCommand } from "./command.ts";
import { DEFAULT_EXTENSIONS, loadRouterConfig } from "./config.ts";
import { processMedia } from "./pipeline.ts";
import { RouteError } from "./router.ts";

const MEDIA_EXTENSIONS = [...new Set(Object.values(DEFAULT_EXTENSIONS).flat())];

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

export default function mediaRouterExtension(pi: ExtensionAPI): void {
  pi.registerCommand("media", {
    description: "Analyze image, audio, video, or PDF files through configured multimodal endpoints",
    handler: async (args, ctx) => handleMediaCommand(pi, args, ctx),
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!likelyContainsMedia(event.text, event.images?.length ?? 0)) return { action: "continue" };

    try {
      const loaded = await loadRouterConfig(ctx.cwd);
      const result = await processMedia(ctx, event.text, event.images, loaded.config);
      if (!result) return { action: "continue" };
      return { action: "transform", text: result.text, images: result.images };
    } catch (error) {
      const message = errorMessage(error);
      ctx.ui.notify(`Media Router: ${message}`, "error");
      if (ctx.hasUI && event.streamingBehavior === undefined) ctx.ui.setEditorText(event.text);
      if (!ctx.hasUI) console.error(`Media Router: ${message}`);
      return { action: "handled" };
    } finally {
      ctx.ui.setStatus("media-router", undefined);
    }
  });
}

export * from "./types.ts";
export { loadGlobalRouterConfig, loadRouterConfig, validateRoutes } from "./config.ts";
export { parseMediaInput } from "./media.ts";
export { createAnalysisPlan, buildPlannerContext } from "./planner.ts";
export { routeMedia } from "./router.ts";
export { defaultBaseUrl, discoverModels, normalizeBaseUrl, protocolModalities, saveSetup } from "./setup.ts";
