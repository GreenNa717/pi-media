import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadRouterConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { processMedia, type PipelineOptions } from "./pipeline.ts";
import { runSetupCommand } from "./setup-command.ts";
import { resetUploadTrust } from "./trust.ts";
import type { DetailLevel } from "./types.ts";

interface ParsedMediaCommand {
  input: string;
  options: PipelineOptions;
}

function parseMediaCommand(args: string): ParsedMediaCommand {
  const separator = args.match(/(?:^|\s)--(?:\s|$)/);
  if (!separator || separator.index === undefined) {
    throw new Error("Usage: /media [--endpoint ID] [--detail task|full] @file... -- <request>");
  }
  let references = args.slice(0, separator.index).trim();
  const request = args.slice(separator.index + separator[0].length).trim();
  let endpointOverride: string | undefined;
  let detail: DetailLevel | undefined;

  references = references.replace(/(?:^|\s)--endpoint\s+([^\s]+)/g, (_match, endpoint: string) => {
    endpointOverride = endpoint;
    return " ";
  });
  references = references.replace(/(?:^|\s)--detail\s+([^\s]+)/g, (_match, value: string) => {
    if (value !== "task" && value !== "full") throw new Error("--detail must be task or full");
    detail = value;
    return " ";
  });
  if (/(?:^|\s)--[A-Za-z]/.test(references)) throw new Error("Unknown /media option");
  if (!references.includes("@")) throw new Error("/media requires at least one @file reference");

  return {
    input: `${references.trim()} ${request || "Describe the supplied media and extract the important information."}`.trim(),
    options: {
      force: true,
      strictMissing: true,
      ...(endpointOverride ? { endpointOverride } : {}),
      ...(detail ? { detail } : {}),
    },
  };
}

function notifyFailure(ctx: ExtensionCommandContext, args: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Media Router: ${message}`, "error");
  if (ctx.hasUI) ctx.ui.setEditorText(`/media ${args}`);
}

export async function handleMediaCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (trimmed === "setup") {
    try {
      await runSetupCommand(ctx);
    } catch (error) {
      notifyFailure(ctx, args, error);
    } finally {
      ctx.ui.setStatus("media-router", undefined);
    }
    return;
  }
  if (trimmed === "doctor" || trimmed === "doctor --probe") {
    try {
      const loaded = await loadRouterConfig(ctx.cwd);
      const result = await runDoctor(ctx, loaded, trimmed.endsWith("--probe"));
      ctx.ui.notify(result.lines.join("\n"), result.ok ? "info" : "error");
    } catch (error) {
      notifyFailure(ctx, args, error);
    }
    return;
  }
  if (trimmed === "trust reset") {
    try {
      const removed = await resetUploadTrust(ctx.cwd);
      ctx.ui.notify(removed ? "Media Router upload trust was reset." : "No Media Router trust entry existed.", "info");
    } catch (error) {
      notifyFailure(ctx, args, error);
    }
    return;
  }

  try {
    const parsed = parseMediaCommand(args);
    if (!ctx.isIdle()) await ctx.waitForIdle();
    const loaded = await loadRouterConfig(ctx.cwd);
    const result = await processMedia(ctx, parsed.input, undefined, loaded.config, parsed.options);
    if (!result) throw new Error("No supported media files were found");
    pi.sendUserMessage([
      { type: "text", text: result.text },
      ...result.images,
    ]);
  } catch (error) {
    notifyFailure(ctx, args, error);
  } finally {
    ctx.ui.setStatus("media-router", undefined);
  }
}
