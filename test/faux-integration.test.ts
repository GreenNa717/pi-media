import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import mediaRouterExtension from "../src/index.ts";

function contextText(context: Context): string {
  return context.messages.map((message) => {
    if (message.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    }
    if (message.role === "toolResult") {
      return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    }
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }).join("\n");
}

function planFor(context: Context) {
  const text = contextText(context);
  const id = text.match(/media_[a-f0-9]{24}/)?.[0];
  assert.ok(id, `planner context should contain the registered media ID: ${JSON.stringify(text)}`);
  return fauxAssistantMessage(JSON.stringify({
    objective: "inspect the image",
    instructions: ["Report exact visible evidence"],
    outputLanguage: "English",
    detail: "task",
    includeTimestamps: false,
    assetFocus: [{ assetId: id, focus: "visible details" }],
  }));
}

test("faux main model receives initial evidence, calls media_query, and continues", async (t) => {
  let upstreamCalls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before streaming the local mock response.
    }
    upstreamCalls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: `upstream report ${upstreamCalls}` })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;

  const cwd = await mkdtemp(join(tmpdir(), "pi-media-faux-"));
  const agentDir = join(cwd, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, ".pi", "media-router.json"), JSON.stringify({
    version: 1,
    endpoints: {
      local: {
        protocol: "openai-responses",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "local-vision",
        modalities: ["image"],
        auth: { type: "none" },
        timeoutMs: 5_000,
      },
    },
    routes: { image: ["local"] },
    privacy: { confirmFirstUpload: false, allowNonInteractive: true },
  }));

  const fauxOptions = {
    api: "faux:pi-media-router-integration",
    provider: "faux-media-router",
    tokensPerSecond: 100_000,
    models: [{ id: "faux-text", name: "Faux Text", input: ["text" as const] }],
  };
  const mainFaux = fauxProvider(fauxOptions);
  const plannerFaux = registerFauxProvider(fauxOptions);
  t.after(() => plannerFaux.unregister());
  let initialSawEvidence = false;
  let initialContextText = "";
  let finalSawToolEvidence = false;
  plannerFaux.setResponses([
    (context) => planFor(context),
    (context) => planFor(context),
  ]);
  mainFaux.setResponses([
    (context) => {
      const text = contextText(context);
      initialContextText = text;
      initialSawEvidence = text.includes("[UNTRUSTED MEDIA EVIDENCE]") && text.includes("upstream report 1");
      return fauxAssistantMessage("initial answer");
    },
    (context) => {
      const id = context.systemPrompt?.match(/media_[a-f0-9]{24}/)?.[0];
      assert.ok(id, "dynamic system prompt should list the current media ID");
      return fauxAssistantMessage(
        [fauxToolCall("media_query", { assetIds: [id], question: "Read the exact text in the upper-right corner.", detail: "task" })],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const text = contextText(context);
      finalSawToolEvidence = text.includes("[UNTRUSTED MEDIA EVIDENCE]") && text.includes("upstream report 2");
      return fauxAssistantMessage("follow-up answer");
    },
  ]);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const fauxModel = mainFaux.getModel();
  modelRuntime.registerNativeProvider(mainFaux.provider);
  await modelRuntime.setRuntimeApiKey(fauxModel.provider, "faux-key");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "pi-media-router", factory: mediaRouterExtension }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: fauxModel,
    resourceLoader,
    settingsManager,
    sessionManager,
    noTools: "builtin",
  });
  t.after(async () => {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  const image: ImageContent = {
    type: "image",
    mimeType: "image/png",
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
  };
  await session.prompt("What is shown?", { images: [image] });
  assert.ok(
    initialSawEvidence,
    `Initial context: ${JSON.stringify(initialContextText)}; main faux calls=${mainFaux.state.callCount}; planner faux calls=${plannerFaux.state.callCount}; upstream=${upstreamCalls}; messages=${JSON.stringify(session.messages)}`,
  );
  const firstUser = session.messages.find((message) => message.role === "user");
  const firstUserText = firstUser?.role === "user"
    ? typeof firstUser.content === "string" ? firstUser.content : contextText({ systemPrompt: "", messages: [firstUser], tools: [] })
    : "";
  assert.ok(firstUserText.includes("[Media: media_"));
  assert.ok(!firstUserText.includes("upstream report 1"));
  assert.ok(sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "media-router-report"));

  await session.prompt("Inspect that image more closely.");
  assert.equal(upstreamCalls, 2);
  assert.equal(finalSawToolEvidence, true);
  assert.ok(session.messages.some((message) => message.role === "toolResult" && message.toolName === "media_query"));
  const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
  assert.equal(lastAssistant?.role === "assistant" ? lastAssistant.content.find((part) => part.type === "text")?.text : undefined, "follow-up answer");
});
