import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildPlannerContext } from "../src/planner.ts";

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntry {
  const value = role === "user"
    ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
    : {
        role,
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: value,
  } as SessionEntry;
}

test("keeps the compaction summary and only recent turns", () => {
  const entries = [
    {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "important compacted context",
      firstKeptEntryId: "u1",
      tokensBefore: 100,
    } as SessionEntry,
    message("u1", "compact", "user", "old user request"),
    message("a1", "u1", "assistant", "old answer"),
    message("u2", "a1", "user", "recent request"),
    message("a2", "u2", "assistant", "recent answer"),
  ];
  const output = buildPlannerContext(entries, { recentTurns: 1, maxContextChars: 10_000, timeoutMs: 1_000, maxOutputTokens: 100 });
  assert.ok(output.includes("important compacted context"));
  assert.ok(output.includes("recent request"));
  assert.ok(!output.includes("old user request"));
});
