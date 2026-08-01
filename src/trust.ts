import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MediaAsset, PrivacyConfig } from "./types.ts";
import { formatBytes, isRecord, sha256 } from "./utils.ts";

interface TrustEntry {
  fingerprint: string;
  approvedAt: string;
}

interface TrustStore {
  version: 1;
  projects: Record<string, TrustEntry>;
}

function defaultStore(): TrustStore {
  return { version: 1, projects: {} };
}

export function trustStorePath(agentDir = getAgentDir()): string {
  return join(agentDir, "media-router", "trust.json");
}

async function projectKey(cwd: string): Promise<string> {
  let canonical = cwd;
  try {
    canonical = await realpath(cwd);
  } catch {
    // The current working directory should exist; retaining the resolved input is a safe fallback.
  }
  return sha256(process.platform === "win32" ? canonical.toLowerCase() : canonical);
}

function hostFingerprint(hosts: readonly string[]): string {
  return sha256([...new Set(hosts.map((host) => host.toLowerCase()))].sort().join("\n"));
}

async function readStore(path: string): Promise<TrustStore> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.projects)) return defaultStore();
    const projects: Record<string, TrustEntry> = {};
    for (const [key, entry] of Object.entries(value.projects)) {
      if (isRecord(entry) && typeof entry.fingerprint === "string" && typeof entry.approvedAt === "string") {
        projects[key] = { fingerprint: entry.fingerprint, approvedAt: entry.approvedAt };
      }
    }
    return { version: 1, projects };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return defaultStore();
    throw error;
  }
}

async function writeStore(path: string, store: TrustStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function isUploadTrusted(cwd: string, hosts: readonly string[], path = trustStorePath()): Promise<boolean> {
  const store = await readStore(path);
  return store.projects[await projectKey(cwd)]?.fingerprint === hostFingerprint(hosts);
}

export async function rememberUploadTrust(cwd: string, hosts: readonly string[], path = trustStorePath()): Promise<void> {
  const store = await readStore(path);
  store.projects[await projectKey(cwd)] = {
    fingerprint: hostFingerprint(hosts),
    approvedAt: new Date().toISOString(),
  };
  await writeStore(path, store);
}

export async function resetUploadTrust(cwd: string, path = trustStorePath()): Promise<boolean> {
  const store = await readStore(path);
  const key = await projectKey(cwd);
  if (!store.projects[key]) return false;
  delete store.projects[key];
  await writeStore(path, store);
  return true;
}

export async function ensureUploadConsent(
  ctx: ExtensionContext,
  assets: readonly MediaAsset[],
  hosts: readonly string[],
  config: PrivacyConfig,
): Promise<void> {
  if (!config.confirmFirstUpload) return;
  if (await isUploadTrusted(ctx.cwd, hosts)) return;
  if (!ctx.hasUI) {
    if (config.allowNonInteractive) return;
    throw new Error("Media upload is not trusted for this project. Approve it once in interactive Pi or set privacy.allowNonInteractive.");
  }

  const fileLines = assets.map((asset) => `- ${asset.name} (${formatBytes(asset.sizeBytes)})`).join("\n");
  const hostLines = [...new Set(hosts)].sort().map((host) => `- ${host}`).join("\n");
  const approved = await ctx.ui.confirm(
    "Upload media files?",
    `Files:\n${fileLines}\n\nPossible destination hosts:\n${hostLines}\n\nFallback routes may upload to any listed host.`,
  );
  if (!approved) throw new Error("Media upload was cancelled");
  if (config.rememberConsent) await rememberUploadTrust(ctx.cwd, hosts);
}
