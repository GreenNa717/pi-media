import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { MediaProgressEvent } from "./types.ts";
import { sanitizeDisplayText } from "./presentation.ts";

interface ProgressState {
  endpoint: string;
  model: string;
  files: string;
  status: string;
  text: string;
}

function plainTruncate(value: string, width: number): string {
  let output = "";
  for (const character of value) {
    if (visibleWidth(output + character) > width) break;
    output += character;
  }
  return output;
}

export class MediaProgressPanel {
  private readonly states = new Map<string, ProgressState>();

  handle(event: MediaProgressEvent, ui: ExtensionUIContext): void {
    const key = event.assetIds.join("|");
    const previous = this.states.get(key);
    const state: ProgressState = previous ?? {
      endpoint: event.endpointId,
      model: event.model,
      files: event.assetNames.join(", "),
      status: "Connecting",
      text: "",
    };
    state.endpoint = event.endpointId;
    state.model = event.model;
    state.files = event.assetNames.join(", ");
    if (event.phase === "start") {
      state.status = "Analyzing";
      state.text = "";
    } else if (event.phase === "upload") {
      state.status = sanitizeDisplayText(event.message ?? "Uploading");
    } else if (event.phase === "delta") {
      state.status = "Streaming";
      state.text += sanitizeDisplayText(event.delta ?? "");
      if (state.text.length > 64_000) state.text = state.text.slice(-64_000);
    } else if (event.phase === "complete") {
      state.status = "Complete";
      state.text = sanitizeDisplayText(event.text ?? state.text);
    } else {
      state.status = `Failed: ${sanitizeDisplayText(event.message ?? "unknown error")}`;
      state.text = "";
    }
    this.states.set(key, state);
    const lines = this.lines();
    ui.setWidget(
      "media-router-progress",
      () => ({
        render: (width: number) => lines.map((line) => plainTruncate(line, Math.max(1, width))),
        invalidate() {},
      }),
      { placement: "aboveEditor" },
    );
  }

  clear(ui: ExtensionUIContext): void {
    this.states.clear();
    ui.setWidget("media-router-progress", undefined);
  }

  lines(): string[] {
    const lines: string[] = ["Multimodal analysis"];
    for (const state of [...this.states.values()].slice(-2)) {
      lines.push(`${state.endpoint}/${state.model} · ${state.status}`);
      lines.push(`Files: ${state.files}`);
      const tail = state.text.split("\n").slice(-4);
      lines.push(...(tail.length && tail.some(Boolean) ? tail : [""]));
      lines.push("");
    }
    while (lines.length < 14) lines.push("");
    return lines.slice(0, 14);
  }
}
