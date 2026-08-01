import assert from "node:assert/strict";
import test from "node:test";
import { formatMediaReferencePrompt } from "../src/pipeline.ts";
import {
  appendEvidenceToUserMessage,
  formatUntrustedEvidence,
  isMediaReportCardData,
  mediaIdsFromText,
  reportCardData,
  sanitizeDisplayText,
} from "../src/presentation.ts";
import { MediaProgressPanel } from "../src/progress.ts";
import type { MediaAsset, MediaReport } from "../src/types.ts";

const ID = "media_0123456789abcdef01234567";
const ASSET: MediaAsset = {
  id: ID,
  index: 0,
  kind: "image",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 8,
  source: { type: "inline", data: "iVBORw0KGgo=" },
};
const REPORT: MediaReport = {
  endpointId: "vision",
  protocol: "openai-responses",
  model: "vision-model",
  assetIds: [ID],
  text: "A settings dialog is visible.",
  warnings: [],
};

test("keeps the visible user prompt clean and injects marked evidence separately", () => {
  const visible = formatMediaReferencePrompt("What is wrong?", [ASSET]);
  assert.equal(visible, `What is wrong?\n\n[Media: ${ID} | screen.png | image]`);
  assert.ok(!visible.includes(REPORT.text));
  assert.deepEqual(mediaIdsFromText(visible), [ID]);

  const evidence = formatUntrustedEvidence([reportCardData("report-1", [ASSET], REPORT)]);
  assert.ok(evidence.startsWith("[UNTRUSTED MEDIA EVIDENCE]"));
  assert.ok(evidence.includes("vision/vision-model"));
  assert.ok(evidence.includes(REPORT.text));
  const contextual = appendEvidenceToUserMessage({ role: "user", content: visible, timestamp: 1 }, evidence);
  assert.ok(typeof contextual.content === "string" && contextual.content.includes(REPORT.text));
  assert.equal(visible.includes(REPORT.text), false);
});

test("removes ANSI and control characters from UI text", () => {
  assert.equal(sanitizeDisplayText("safe\u001b[31m red\u001b[0m\u0000\u009b\tvalue\r\nnext"), "safe red  value\nnext");
});

test("rejects malformed persisted report cards", () => {
  assert.equal(isMediaReportCardData({
    version: 1,
    reportId: "broken",
    createdAt: "now",
    sources: [],
    report: { endpointId: "x", protocol: "gemini", model: "x", assetIds: [], text: "x" },
  }), false);
});

test("progress panel remains fixed-height with concurrent groups", () => {
  const panel = new MediaProgressPanel();
  let factory: ((...args: never[]) => { render(width: number): string[] }) | undefined;
  const ui = {
    setWidget(_key: string, content: unknown) {
      if (typeof content === "function") factory = content as typeof factory;
    },
  };
  const base = {
    protocol: "openai-responses" as const,
    model: "vision-model",
  };
  panel.handle({ phase: "start", endpointId: "first", assetIds: [ID], assetNames: ["a-long-file-name.png"], ...base }, ui as never);
  panel.handle({ phase: "delta", endpointId: "first", assetIds: [ID], assetNames: ["a-long-file-name.png"], delta: "hello\u001b[2J world", ...base }, ui as never);
  panel.handle({ phase: "start", endpointId: "second", assetIds: [`${ID.slice(0, -1)}8`], assetNames: ["b.png"], ...base }, ui as never);
  const component = factory?.();
  const lines = component?.render(18) ?? [];
  assert.equal(lines.length, 14);
  assert.ok(lines.every((line) => !line.includes("\u001b")));
  assert.ok(lines.every((line) => line.length <= 18));
});
