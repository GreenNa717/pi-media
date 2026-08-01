import { consumeSse, fetchWithRetry, HttpError, redactSecrets, type FetchInit, type FetchOptions } from "../http.ts";
import { isRecord } from "../utils.ts";

export interface StreamingParser {
  label: string;
  parseJson(value: unknown): string;
  parseEvent(value: unknown, eventName?: string): string | undefined;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${label} returned invalid JSON`);
  }
}

function eventError(value: unknown, eventName?: string): string | undefined {
  if (eventName === "error") {
    if (isRecord(value) && typeof value.message === "string") return value.message;
    return "stream returned an error event";
  }
  if (isRecord(value) && value.type === "error") {
    if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
    if (typeof value.message === "string") return value.message;
    return "stream returned an error event";
  }
  return undefined;
}

export async function readStreamingText(
  response: Response,
  parser: StreamingParser,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    const body = await response.text();
    const text = parser.parseJson(parseJson(body, parser.label));
    onDelta(text);
    return text;
  }

  let output = "";
  await consumeSse(
    response,
    async (event) => {
      if (event.data.trim() === "[DONE]") return;
      const value = parseJson(event.data, parser.label);
      const error = eventError(value, event.event);
      if (error) throw new HttpError(`${parser.label} ${error}`);
      const delta = parser.parseEvent(value, event.event);
      if (!delta) return;
      output += delta;
      onDelta(delta);
    },
    signal,
  );
  if (!output.trim()) throw new HttpError(`${parser.label} stream returned no text`);
  return output.trim();
}

export function streamFallbackAllowed(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status !== undefined) return [400, 404, 405, 406, 415, 422, 501].includes(error.status);
  return !error.retryable;
}

export async function requestStreamingWithFallback(options: {
  url: string;
  init: () => FetchInit | Promise<FetchInit>;
  fetchOptions: FetchOptions;
  parser: StreamingParser;
  onDelta: (delta: string) => void;
  nonStreaming: () => Promise<string>;
}): Promise<string> {
  let receivedDelta = false;
  const onDelta = (delta: string): void => {
    receivedDelta = true;
    options.onDelta(delta);
  };
  try {
    const response = await fetchWithRetry(options.url, options.init, options.fetchOptions);
    return await readStreamingText(response, options.parser, onDelta, options.fetchOptions.signal);
  } catch (error) {
    if (options.fetchOptions.signal?.aborted) throw error;
    if (receivedDelta || !streamFallbackAllowed(error)) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error), options.fetchOptions.secrets ?? []);
      if (error instanceof HttpError) {
        throw new HttpError(message, {
          ...(error.status !== undefined ? { status: error.status } : {}),
          retryable: error.retryable,
        });
      }
      throw new Error(message);
    }
    const text = await options.nonStreaming();
    onDelta(text);
    return text;
  }
}
