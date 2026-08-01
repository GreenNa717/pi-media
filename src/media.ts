import { open, realpath, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionConfig, MediaAsset, MediaKind, ParsedMediaInput } from "./types.ts";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/avi",
  ".wmv": "video/wmv",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
  ".pdf": "application/pdf",
};

const REFERENCE_PATTERN = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？\)\]\}]+$/u;

interface PathReference {
  start: number;
  end: number;
  pathText: string;
  explicit: boolean;
}

export class MediaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaInputError";
  }
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString("ascii");
}

function matchesSignature(mimeType: string, header: Buffer): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return startsWith(header, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return ascii(header, 0, 6) === "GIF87a" || ascii(header, 0, 6) === "GIF89a";
    case "image/webp":
      return ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "WEBP";
    case "image/bmp":
      return ascii(header, 0, 2) === "BM";
    case "audio/mpeg":
      return ascii(header, 0, 3) === "ID3" || (header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0);
    case "audio/wav":
      return ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "WAVE";
    case "audio/mp4":
    case "video/mp4":
    case "video/quicktime":
    case "video/3gpp":
      return ascii(header, 4, 4) === "ftyp";
    case "audio/aac":
      return header[0] === 0xff && (((header[1] ?? 0) & 0xf6) === 0xf0);
    case "audio/ogg":
      return ascii(header, 0, 4) === "OggS";
    case "audio/flac":
      return ascii(header, 0, 4) === "fLaC";
    case "video/mpeg":
      return startsWith(header, [0x00, 0x00, 0x01, 0xba]) || startsWith(header, [0x00, 0x00, 0x01, 0xb3]);
    case "video/webm":
    case "video/x-matroska":
      return startsWith(header, [0x1a, 0x45, 0xdf, 0xa3]);
    case "video/avi":
      return ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "AVI ";
    case "video/wmv":
      return startsWith(header, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);
    case "video/x-flv":
      return ascii(header, 0, 3) === "FLV";
    case "application/pdf":
      return ascii(header, 0, 5) === "%PDF-";
    default:
      return false;
  }
}

export function kindForFileName(fileName: string, extensions: ExtensionConfig): MediaKind | undefined {
  const extension = extname(fileName).toLowerCase();
  return (Object.keys(extensions) as MediaKind[]).find((kind) => extensions[kind].includes(extension));
}

export function mimeForFileName(fileName: string): string | undefined {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()];
}

function expandTilde(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return resolve(homedir(), filePath.slice(2));
  return filePath;
}

async function inspectFile(filePath: string, kind: MediaKind): Promise<Omit<MediaAsset, "id" | "index">> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") throw new MediaInputError(`Media file not found: ${filePath}`);
    throw error;
  }
  if (!info.isFile()) throw new MediaInputError(`Media reference is not a file: ${filePath}`);
  if (info.size === 0) throw new MediaInputError(`Media file is empty: ${filePath}`);
  const mimeType = mimeForFileName(filePath);
  if (!mimeType) throw new MediaInputError(`No MIME mapping for media file: ${filePath}`);
  const handle = await open(filePath, "r");
  const header = Buffer.alloc(64);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (!matchesSignature(mimeType, header)) {
    throw new MediaInputError(`File signature does not match ${mimeType}: ${filePath}`);
  }
  const canonicalPath = await realpath(filePath);
  return {
    kind,
    name: canonicalPath.split(/[\\/]/).at(-1) ?? canonicalPath,
    mimeType,
    sizeBytes: info.size,
    source: { type: "file", path: canonicalPath },
  };
}

function trimReferenceToken(token: string, extensions: ExtensionConfig): { pathText: string; trailing: string } {
  let pathText = token;
  let trailing = "";
  while (pathText) {
    if (kindForFileName(pathText, extensions)) return { pathText, trailing };
    const match = pathText.match(TRAILING_PUNCTUATION);
    if (!match?.[0]) break;
    trailing = `${match[0]}${trailing}`;
    pathText = pathText.slice(0, -match[0].length);
  }
  return { pathText: token, trailing: "" };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extensionPattern(extensions: ExtensionConfig): string {
  const values = [...new Set(Object.values(extensions).flat().map((value) => value.toLowerCase()))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  return `(?:${values.join("|")})`;
}

function explicitPathReferences(text: string, extensions: ExtensionConfig): PathReference[] {
  const references: PathReference[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const whole = match[0];
    const start = match.index;
    const rawPath = match[1] ?? match[2] ?? match[3];
    if (start === undefined || rawPath === undefined) continue;
    const quoted = match[1] !== undefined || match[2] !== undefined;
    const { pathText, trailing } = quoted ? { pathText: rawPath, trailing: "" } : trimReferenceToken(rawPath, extensions);
    if (!kindForFileName(pathText, extensions)) continue;
    references.push({
      start,
      end: start + (quoted ? whole.length : whole.length - trailing.length),
      pathText,
      explicit: true,
    });
  }
  return references;
}

function overlaps(reference: PathReference, others: readonly PathReference[]): boolean {
  return others.some((other) => reference.start < other.end && reference.end > other.start);
}

function regexPathReferences(
  text: string,
  pattern: RegExp,
  pathFromMatch: (match: RegExpMatchArray) => string | undefined = (match) => match[0],
): PathReference[] {
  const references: PathReference[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const pathText = pathFromMatch(match);
    if (start === undefined || pathText === undefined) continue;
    references.push({ start, end: start + match[0].length, pathText, explicit: false });
  }
  return references;
}

function barePathReferences(
  text: string,
  extensions: ExtensionConfig,
  explicitReferences: readonly PathReference[],
): PathReference[] {
  const suffix = extensionPattern(extensions);
  if (suffix === "(?:)") return [];
  const boundary = `(?=$|[\\s,;:!?，。；：！？)\\]}'\"])`;
  const patterns: Array<{ regex: RegExp; pathFromMatch?: (match: RegExpMatchArray) => string | undefined }> = [
    {
      regex: new RegExp(`([\"'])([^\"'\\r\\n]+?${suffix})\\1`, "giu"),
      pathFromMatch: (match) => match[2],
    },
    {
      regex: new RegExp(`file:\\/\\/\\/[^\\r\\n\"']*?${suffix}${boundary}`, "giu"),
      pathFromMatch: (match) => {
        try {
          return fileURLToPath(match[0]);
        } catch {
          return undefined;
        }
      },
    },
    { regex: new RegExp(`[A-Za-z]:[\\\\/][^\\r\\n\"'<>|?*]*?${suffix}${boundary}`, "giu") },
    { regex: new RegExp(`\\\\\\\\[^\\r\\n\"'<>|?*]*?${suffix}${boundary}`, "giu") },
    { regex: new RegExp(`(?<![:A-Za-z0-9_])\\/(?!\\/)[^\\r\\n\"']*?${suffix}${boundary}`, "giu") },
    {
      regex: new RegExp(
        `(?<![@A-Za-z0-9_:\\\\/])(?:\\.{1,2}[\\\\/])?[^\\s\\r\\n\"'<>|:?*]+?${suffix}${boundary}`,
        "giu",
      ),
    },
  ];

  const selected: PathReference[] = [];
  for (const { regex, pathFromMatch } of patterns) {
    for (const reference of regexPathReferences(text, regex, pathFromMatch)) {
      if (overlaps(reference, explicitReferences) || overlaps(reference, selected)) continue;
      selected.push(reference);
    }
  }
  return selected.sort((a, b) => a.start - b.start);
}

function inlineImageAsset(image: ImageContent, index: number): MediaAsset {
  const data = Buffer.from(image.data, "base64");
  if (data.length === 0) throw new MediaInputError(`Attached image ${index + 1} is empty`);
  if (!matchesSignature(image.mimeType, data.subarray(0, 64))) {
    throw new MediaInputError(`Attached image ${index + 1} does not match ${image.mimeType}`);
  }
  return {
    id: `media-${index + 1}`,
    index,
    kind: "image",
    name: `attachment-${index + 1}`,
    mimeType: image.mimeType,
    sizeBytes: data.length,
    source: { type: "inline", data: image.data },
  };
}

export async function parseMediaInput(
  text: string,
  images: readonly ImageContent[] | undefined,
  cwd: string,
  extensions: ExtensionConfig,
  strictMissing = false,
): Promise<ParsedMediaInput> {
  const assets: MediaAsset[] = (images ?? []).map(inlineImageAsset);
  const seenPaths = new Set<string>();
  const missingReferences: string[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  const explicitReferences = explicitPathReferences(text, extensions);
  const references = [
    ...explicitReferences,
    ...barePathReferences(text, extensions, explicitReferences),
  ].sort((a, b) => a.start - b.start);

  for (const reference of references) {
    const kind = kindForFileName(reference.pathText, extensions);
    if (!kind) continue;

    const expanded = expandTilde(reference.pathText);
    const resolvedPath = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    try {
      const inspected = await inspectFile(resolvedPath, kind);
      const canonicalPath = inspected.source.type === "file" ? inspected.source.path : resolvedPath;
      if (!seenPaths.has(canonicalPath)) {
        const assetIndex = assets.length;
        assets.push({ ...inspected, id: `media-${assetIndex + 1}`, index: assetIndex });
        seenPaths.add(canonicalPath);
      }
      replacements.push({ start: reference.start, end: reference.end, value: "" });
    } catch (error) {
      if (error instanceof MediaInputError && error.message.startsWith("Media file not found:")) {
        if (reference.explicit) {
          missingReferences.push(reference.pathText);
          if (strictMissing) throw error;
        }
        continue;
      }
      throw error;
    }
  }

  let cleanedText = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    cleanedText = `${cleanedText.slice(0, replacement.start)}${replacement.value}${cleanedText.slice(replacement.end)}`;
  }
  cleanedText = cleanedText.replace(/[ \t]{2,}/g, " ").trim();
  return { assets, cleanedText, missingReferences };
}

export async function assetBase64(asset: MediaAsset): Promise<string> {
  if (asset.source.type === "inline") return asset.source.data;
  return (await readFile(asset.source.path)).toString("base64");
}

export async function assetBuffer(asset: MediaAsset): Promise<Buffer> {
  if (asset.source.type === "inline") return Buffer.from(asset.source.data, "base64");
  return readFile(asset.source.path);
}

export async function assetToImageContent(asset: MediaAsset): Promise<ImageContent> {
  if (asset.kind !== "image") throw new MediaInputError(`${asset.name} is not an image`);
  return { type: "image", mimeType: asset.mimeType, data: await assetBase64(asset) };
}
