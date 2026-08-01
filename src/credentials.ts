import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./utils.ts";

interface CredentialDocument {
  version: 1;
  keys: Record<string, string>;
}

export interface CredentialStoreOptions {
  agentDir?: string;
}

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export function storedCredentialsPath(options: CredentialStoreOptions = {}): string {
  return join(options.agentDir ?? getAgentDir(), "media-router", "credentials.json");
}

function parseCredentialDocument(value: unknown, path: string): CredentialDocument {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.keys)) {
    throw new CredentialStoreError(`Invalid Media Router credential store: ${path}`);
  }
  const keys: Record<string, string> = {};
  for (const [id, key] of Object.entries(value.keys)) {
    if (typeof key !== "string" || !key) throw new CredentialStoreError(`Invalid Media Router credential store: ${path}`);
    keys[id] = key;
  }
  return { version: 1, keys };
}

async function readDocument(path: string): Promise<CredentialDocument> {
  try {
    return parseCredentialDocument(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") return { version: 1, keys: {} };
    if (error instanceof CredentialStoreError) throw error;
    throw new CredentialStoreError(`Could not read Media Router credentials: ${path}`);
  }
}

async function writeDocument(path: string, document: CredentialDocument): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function readStoredApiKey(id: string, options: CredentialStoreOptions = {}): Promise<string | undefined> {
  return (await readDocument(storedCredentialsPath(options))).keys[id];
}

export async function replaceStoredApiKey(
  id: string,
  key: string | undefined,
  options: CredentialStoreOptions = {},
): Promise<string | undefined> {
  const path = storedCredentialsPath(options);
  const document = await readDocument(path);
  const previous = document.keys[id];
  if (key === undefined) delete document.keys[id];
  else document.keys[id] = key;
  await writeDocument(path, document);
  return previous;
}
