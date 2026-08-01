import { abortSignalWithTimeout, sleep, truncate } from "./utils.ts";

export class HttpError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export type FetchInit = RequestInit & { duplex?: "half" };

export interface FetchOptions {
  timeoutMs: number;
  retries?: number;
  signal?: AbortSignal;
  secrets?: readonly string[];
}

export interface ServerSentEvent {
  event?: string;
  data: string;
  id?: string;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const raw = response?.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));
  }
  return 400 * 2 ** attempt;
}

export async function fetchWithRetry(
  url: string,
  initFactory: () => FetchInit | Promise<FetchInit>,
  options: FetchOptions,
): Promise<Response> {
  const retries = options.retries ?? 1;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response | undefined;
    try {
      const init = await initFactory();
      response = await fetch(url, {
        ...init,
        signal: abortSignalWithTimeout(options.signal, options.timeoutMs),
      });
      if (response.ok) return response;

      const body = redactSecrets(truncate(await response.text(), 2_000), options.secrets ?? []);
      const retryable = isRetryableStatus(response.status);
      lastError = new HttpError(`HTTP ${response.status} from ${new URL(url).host}: ${body || response.statusText}`, {
        status: response.status,
        retryable,
      });
      if (!retryable || attempt >= retries) throw lastError;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : error;
      const current = error instanceof Error ? error : new Error(String(error));
      if (current instanceof HttpError && !current.retryable) throw current;
      lastError = current;
      if (attempt >= retries) break;
    }
    await sleep(retryDelay(response, attempt), options.signal);
  }

  const message = redactSecrets(lastError?.message ?? `Request failed: ${url}`, options.secrets ?? []);
  if (lastError instanceof HttpError) {
    throw new HttpError(message, { ...(lastError.status ? { status: lastError.status } : {}), retryable: lastError.retryable });
  }
  throw new HttpError(message, { retryable: true });
}

export async function requestJson(
  url: string,
  initFactory: () => FetchInit | Promise<FetchInit>,
  options: FetchOptions,
): Promise<unknown> {
  const response = await fetchWithRetry(url, initFactory, options);
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`Invalid JSON response from ${new URL(url).host}: ${truncate(text, 1_000)}`);
  }
}

export async function consumeSse(
  response: Response,
  onEvent: (event: ServerSentEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new HttpError("Streaming response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      return;
    }
    await onEvent({
      ...(eventName ? { event: eventName } : {}),
      data: dataLines.join("\n"),
      ...(eventId ? { id: eventId } : {}),
    });
    eventName = undefined;
    eventId = undefined;
    dataLines = [];
  };

  const processLine = async (line: string): Promise<void> => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) eventId = value;
  };

  const drain = async (atEnd: boolean): Promise<void> => {
    while (buffer.length > 0) {
      const lf = buffer.indexOf("\n");
      const cr = buffer.indexOf("\r");
      let index = -1;
      if (lf >= 0 && cr >= 0) index = Math.min(lf, cr);
      else index = Math.max(lf, cr);
      if (index < 0) {
        if (atEnd) {
          const finalLine = buffer;
          buffer = "";
          await processLine(finalLine);
        }
        return;
      }
      if (!atEnd && buffer[index] === "\r" && index === buffer.length - 1) return;
      const line = buffer.slice(0, index);
      const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(index + length);
      await processLine(line);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Media request was cancelled");
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      await drain(false);
    }
    buffer += decoder.decode();
    await drain(true);
    await dispatch();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function joinEndpointUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/")) return new URL(path, new URL(baseUrl).origin).toString();
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
