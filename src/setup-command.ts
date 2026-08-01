import type {
  ExtensionCommandContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { loadGlobalRouterConfig, loadRouterConfig } from "./config.ts";
import { storedCredentialsPath } from "./credentials.ts";
import {
  defaultBaseUrl,
  discoverModels,
  type DiscoveredModel,
  normalizeBaseUrl,
  protocolModalities,
  saveSetup,
} from "./setup.ts";
import type { AdapterProtocol, MediaKind } from "./types.ts";

const PROTOCOL_OPTIONS = [
  { label: "Gemini（图片、音频、视频、PDF）", value: "gemini" },
  { label: "OpenAI Responses（图片、PDF）", value: "openai-responses" },
  { label: "OpenAI Chat Completions（图片、MP3/WAV）", value: "openai-chat" },
  { label: "Anthropic Messages（图片、PDF）", value: "anthropic-messages" },
] as const satisfies readonly { label: string; value: AdapterProtocol }[];

const KIND_NAMES: Record<MediaKind, string> = {
  image: "图片",
  audio: "音频",
  video: "视频",
  pdf: "PDF",
};

const MODEL_PAGE_SIZE = 50;

class MaskedInputComponent extends Container implements Focusable {
  private readonly input = new Input();
  private readonly valueText = new Text("> ", 1, 0);
  private readonly keybindings: KeybindingsManager;
  private readonly done: (value: string | undefined) => void;
  private completed = false;
  private isFocused = false;

  constructor(title: string, keybindings: KeybindingsManager, done: (value: string | undefined) => void) {
    super();
    this.keybindings = keybindings;
    this.done = done;
    this.addChild(new Text(title, 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.valueText);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.completed) return;
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      this.completed = true;
      this.done(this.input.getValue());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.completed = true;
      this.done(undefined);
      return;
    }
    this.input.handleInput(data);
    const length = [...this.input.getValue()].length;
    this.valueText.setText(`> ${"*".repeat(Math.min(length, 64))}${length > 64 ? "..." : ""}`);
  }
}

async function promptSecret(ctx: ExtensionCommandContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((_tui, _theme, keybindings, done) =>
    new MaskedInputComponent("输入 API Key（内容已隐藏）", keybindings, done),
  );
}

function protocolFromLabel(label: string): AdapterProtocol | undefined {
  return PROTOCOL_OPTIONS.find((option) => option.label === label)?.value;
}

function formatModel(model: DiscoveredModel): string {
  return model.displayName && model.displayName !== model.id
    ? `[模型] ${model.id} | ${model.displayName}`
    : `[模型] ${model.id}`;
}

async function selectModel(
  ctx: ExtensionCommandContext,
  models: readonly DiscoveredModel[],
): Promise<DiscoveredModel | undefined> {
  let query = "";
  let page = 0;
  while (true) {
    const filtered = query
      ? models.filter((model) => `${model.id}\n${model.displayName ?? ""}`.toLowerCase().includes(query.toLowerCase()))
      : [...models];
    const pageCount = Math.max(1, Math.ceil(filtered.length / MODEL_PAGE_SIZE));
    page = Math.min(page, pageCount - 1);
    const visible = filtered.slice(page * MODEL_PAGE_SIZE, (page + 1) * MODEL_PAGE_SIZE);
    const modelLabels = visible.map(formatModel);
    const options = [
      ...modelLabels,
      ...(page > 0 ? ["[操作] 上一页"] : []),
      ...(page + 1 < pageCount ? ["[操作] 下一页"] : []),
      "[操作] 搜索模型",
      ...(query ? ["[操作] 清除筛选"] : []),
      "[操作] 手动输入模型 ID",
    ];
    const title = query
      ? `选择模型：匹配 ${filtered.length} 个，第 ${page + 1}/${pageCount} 页`
      : `选择模型：共 ${models.length} 个，第 ${page + 1}/${pageCount} 页`;
    const selected = await ctx.ui.select(title, options);
    if (selected === undefined) return undefined;
    const modelIndex = modelLabels.indexOf(selected);
    if (modelIndex >= 0) return visible[modelIndex];
    if (selected === "[操作] 上一页") {
      page -= 1;
      continue;
    }
    if (selected === "[操作] 下一页") {
      page += 1;
      continue;
    }
    if (selected === "[操作] 清除筛选") {
      query = "";
      page = 0;
      continue;
    }
    if (selected === "[操作] 搜索模型") {
      const nextQuery = await ctx.ui.input("输入模型关键词");
      if (nextQuery === undefined) continue;
      const trimmed = nextQuery.trim();
      if (!trimmed) continue;
      const matchCount = models.filter((model) =>
        `${model.id}\n${model.displayName ?? ""}`.toLowerCase().includes(trimmed.toLowerCase()),
      ).length;
      if (matchCount === 0) {
        ctx.ui.notify("没有匹配的模型", "warning");
        continue;
      }
      query = trimmed;
      page = 0;
      continue;
    }
    if (selected === "[操作] 手动输入模型 ID") {
      const manual = await ctx.ui.input("输入模型 ID");
      if (manual?.trim()) return { id: manual.trim() };
    }
  }
}

function modalityPresets(protocol: AdapterProtocol): Array<{ label: string; kinds: MediaKind[] }> {
  const all = protocolModalities(protocol);
  const presets: Array<{ label: string; kinds: MediaKind[] }> = [
    { label: `全部：${all.map((kind) => KIND_NAMES[kind]).join("、")}`, kinds: all },
    ...all.map((kind) => ({ label: `仅${KIND_NAMES[kind]}`, kinds: [kind] })),
  ];
  if (all.includes("image") && all.includes("pdf") && all.length > 2) {
    presets.push({ label: "图片和 PDF", kinds: ["image", "pdf"] });
  }
  if (all.includes("audio") && all.includes("video")) {
    presets.push({ label: "音频和视频", kinds: ["audio", "video"] });
  }
  return presets;
}

function cancelled(ctx: ExtensionCommandContext): void {
  ctx.ui.notify("Media Router 配置已取消", "info");
}

export async function runSetupCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("/media setup 只能在 Pi 交互终端中使用");

  const scopeLabels = ["全局配置（所有项目）", "当前项目配置"];
  const scope = await ctx.ui.select("保存位置", scopeLabels);
  if (!scope) return cancelled(ctx);

  const protocolLabel = await ctx.ui.select("选择接口协议", PROTOCOL_OPTIONS.map((option) => option.label));
  if (!protocolLabel) return cancelled(ctx);
  const protocol = protocolFromLabel(protocolLabel);
  if (!protocol) throw new Error("未知协议");

  const suggestedUrl = defaultBaseUrl(protocol);
  const enteredUrl = await ctx.ui.input(`API URL（留空使用 ${suggestedUrl}）`);
  if (enteredUrl === undefined) return cancelled(ctx);
  const baseUrl = normalizeBaseUrl(enteredUrl.trim() || suggestedUrl);

  const authMode = await ctx.ui.select("鉴权方式", ["输入 API Key", "无需鉴权"]);
  if (!authMode) return cancelled(ctx);
  let apiKey: string | undefined;
  if (authMode === "输入 API Key") {
    const enteredKey = await promptSecret(ctx);
    if (enteredKey === undefined) return cancelled(ctx);
    if (!enteredKey.trim()) throw new Error("API Key 不能为空");
    apiKey = enteredKey.trim();
  }

  ctx.ui.setStatus("media-router", "正在获取模型列表");
  let models: DiscoveredModel[];
  try {
    models = await discoverModels(protocol, baseUrl, {
      ...(apiKey ? { apiKey } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } finally {
    ctx.ui.setStatus("media-router", undefined);
  }
  if (models.length === 0) throw new Error("接口没有返回可用模型");

  const model = await selectModel(ctx, models);
  if (!model) return cancelled(ctx);
  const presets = modalityPresets(protocol);
  const modalityLabel = await ctx.ui.select("启用媒体类型", presets.map((preset) => preset.label));
  if (!modalityLabel) return cancelled(ctx);
  const modalities = presets.find((preset) => preset.label === modalityLabel)?.kinds;
  if (!modalities) throw new Error("未知媒体类型");

  const enteredEndpointId = await ctx.ui.input("端点 ID（留空使用 media）");
  if (enteredEndpointId === undefined) return cancelled(ctx);
  const endpointId = enteredEndpointId.trim() || "media";

  const global = await loadGlobalRouterConfig();
  const project = scope === scopeLabels[0] ? undefined : await loadRouterConfig(ctx.cwd);
  const baseConfig = project?.config ?? global.config;
  const targetPath = project?.projectPath ?? global.globalPath;
  const confirmed = await ctx.ui.confirm(
    "保存 Media Router 配置",
    [
      `文件：${targetPath}`,
      `端点：${endpointId}`,
      `主机：${new URL(baseUrl).host}`,
      `模型：${model.id}`,
      `媒体：${modalities.map((kind) => KIND_NAMES[kind]).join("、")}`,
      apiKey ? `Key：保存到本地未加密凭据文件 ${storedCredentialsPath()}` : "鉴权：无",
    ].join("\n"),
  );
  if (!confirmed) return cancelled(ctx);

  await saveSetup({
    targetPath,
    baseRoutes: baseConfig.routes,
    endpointId,
    protocol,
    baseUrl,
    model: model.id,
    modalities,
    ...(apiKey ? { apiKey } : {}),
  });
  ctx.ui.notify(`配置已保存：${targetPath}\n运行 /media doctor 检查配置。`, "info");
}
