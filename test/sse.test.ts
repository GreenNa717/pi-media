import assert from "node:assert/strict";
import test from "node:test";
import { consumeSse } from "../src/http.ts";
import { readStreamingText, streamFallbackAllowed } from "../src/adapters/streaming.ts";
import { HttpError } from "../src/http.ts";

function chunkedResponse(text: string, sizes: readonly number[]): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let sizeIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const size = sizes[sizeIndex++ % sizes.length] ?? 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("parses arbitrarily chunked UTF-8, CRLF, and multiline SSE data", async () => {
  const events: Array<{ event?: string; data: string }> = [];
  const response = chunkedResponse(
    ": heartbeat\r\nevent: delta\r\ndata: {\"text\":\"你\r\ndata: 好\"}\r\n\r\ndata: [DONE]\r\n\r\n",
    [1, 2, 1, 3, 5],
  );
  await consumeSse(response, (event) => { events.push(event); });
  assert.deepEqual(events, [
    { event: "delta", data: "{\"text\":\"你\n好\"}" },
    { data: "[DONE]" },
  ]);
});

test("stream text parser handles DONE and JSON responses", async () => {
  const deltas: string[] = [];
  const streamed = await readStreamingText(
    chunkedResponse('data: {"delta":"A"}\n\ndata: {"delta":"中"}\n\ndata: [DONE]\n\n', [2, 1, 4]),
    {
      label: "test stream",
      parseJson: (value) => String((value as { text: string }).text),
      parseEvent: (value) => (value as { delta?: string }).delta,
    },
    (delta) => deltas.push(delta),
  );
  assert.equal(streamed, "A中");
  assert.deepEqual(deltas, ["A", "中"]);

  const jsonDeltas: string[] = [];
  const json = await readStreamingText(
    new Response(JSON.stringify({ text: "plain JSON" }), { headers: { "content-type": "application/json" } }),
    {
      label: "test JSON",
      parseJson: (value) => String((value as { text: string }).text),
      parseEvent: () => undefined,
    },
    (delta) => jsonDeltas.push(delta),
  );
  assert.equal(json, "plain JSON");
  assert.deepEqual(jsonDeltas, ["plain JSON"]);
});

test("propagates a stream failure after a partial delta", async () => {
  const encoder = new TextEncoder();
  let pull = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pull++ === 0) controller.enqueue(encoder.encode('data: {"delta":"partial"}\n\n'));
      else controller.error(new Error("connection reset"));
    },
  }), { headers: { "content-type": "text/event-stream" } });
  const deltas: string[] = [];
  await assert.rejects(
    readStreamingText(
      response,
      {
        label: "broken stream",
        parseJson: () => "",
        parseEvent: (value) => (value as { delta?: string }).delta,
      },
      (delta) => deltas.push(delta),
    ),
    /connection reset/,
  );
  assert.deepEqual(deltas, ["partial"]);
});

test("only allows fallback for explicit or non-retryable stream rejection", () => {
  assert.equal(streamFallbackAllowed(new HttpError("unsupported", { status: 404 })), true);
  assert.equal(streamFallbackAllowed(new HttpError("bad stream event")), true);
  assert.equal(streamFallbackAllowed(new HttpError("network timeout", { retryable: true })), false);
  assert.equal(streamFallbackAllowed(new Error("connection reset")), false);
});
