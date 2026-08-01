import type { AdapterProtocol, ProtocolAdapter } from "../types.ts";
import { anthropicMessagesAdapter } from "./anthropic-messages.ts";
import { geminiAdapter } from "./gemini.ts";
import { openAIChatAdapter } from "./openai-chat.ts";
import { openAIResponsesAdapter } from "./openai-responses.ts";

export const ADAPTERS: ReadonlyMap<AdapterProtocol, ProtocolAdapter> = new Map([
  [openAIChatAdapter.protocol, openAIChatAdapter],
  [openAIResponsesAdapter.protocol, openAIResponsesAdapter],
  [anthropicMessagesAdapter.protocol, anthropicMessagesAdapter],
  [geminiAdapter.protocol, geminiAdapter],
]);

export { anthropicMessagesAdapter, geminiAdapter, openAIChatAdapter, openAIResponsesAdapter };
