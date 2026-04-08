import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type TelegramUser = {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

type AssistantIntent =
  | { kind: "capture"; content: string }
  | { kind: "help" }
  | { kind: "stats" }
  | { kind: "list"; limit: number; type?: string; days?: number }
  | { kind: "search"; query: string; limit: number }
  | { kind: "assistant" };

type ChatRole = "user" | "assistant" | "system" | "tool";

type StoredMessage = {
  role: ChatRole;
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

type ChatState = {
  chat_id: number;
  active_summary: string;
  preferences: Record<string, unknown>;
  last_summary_at: string | null;
  last_active_at: string | null;
};

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenRouterMessage = {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
};

type OpenRouterResponseMessage = {
  role: "assistant";
  content?: string | null;
  tool_calls?: OpenRouterToolCall[];
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const TELEGRAM_ALLOWED_CHAT_IDS = Deno.env.get("TELEGRAM_ALLOWED_CHAT_IDS")!;
const OPENBRAIN_MCP_URL = Deno.env.get("OPENBRAIN_MCP_URL")!;
const OPENBRAIN_MCP_KEY = Deno.env.get("OPENBRAIN_MCP_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "openai/gpt-4.1-mini";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const allowedChatIds = new Set(
  TELEGRAM_ALLOWED_CHAT_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const CHAT_MEMORY_DAYS = 20;
const RECENT_CONTEXT_MESSAGES = 8;
const MAX_TELEGRAM_CHUNK = 3800;
const MAX_ASSISTANT_ROUNDS = 3;
const MAX_MODEL_TOOL_OUTPUT_CHARS = 8000;

const MCP_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "capture_thought",
      description: "Save a new thought into Open Brain.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Thought text to capture." },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_thoughts",
      description: "Search saved thoughts in Open Brain by semantic query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of matching thoughts to return.",
          },
          threshold: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Optional semantic matching threshold.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_thoughts",
      description: "List recent or filtered thoughts from Open Brain.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of thoughts to return.",
          },
          type: { type: "string", description: "Optional thought type filter." },
          topic: { type: "string", description: "Optional topic filter." },
          person: { type: "string", description: "Optional person filter." },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 365,
            description: "Optional lookback window in days.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "thought_stats",
      description: "Return a compact thought summary for Open Brain.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

function getMessageFromUpdate(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.channel_post ?? null;
}

function getMessageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function describeChat(chat: TelegramChat): string {
  if (chat.title) return `${chat.type}:${chat.title}`;
  if (chat.username) return `${chat.type}:@${chat.username}`;
  if (chat.first_name || chat.last_name) {
    return `${chat.type}:${[chat.first_name, chat.last_name].filter(Boolean).join(" ")}`;
  }
  return `${chat.type}:${chat.id}`;
}

function describeSender(message: TelegramMessage): string | null {
  if (message.from?.username) return `@${message.from.username}`;
  if (message.from?.first_name || message.from?.last_name) {
    return [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  }
  if (message.sender_chat?.title) return message.sender_chat.title;
  if (message.sender_chat?.username) return `@${message.sender_chat.username}`;
  return null;
}

function buildThoughtContent(message: TelegramMessage, rawText: string): string {
  const context = [
    "Source: Telegram",
    `Chat: ${describeChat(message.chat)}`,
    `Message ID: ${message.message_id}`,
    `Sent At: ${new Date(message.date * 1000).toISOString()}`,
  ];

  const sender = describeSender(message);
  if (sender) context.splice(2, 0, `From: ${sender}`);

  return `${rawText}\n\n[${context.join(" | ")}]`;
}

function buildHelpText(): string {
  return [
    "Open Brain assistant commands:",
    "/ideas - list recent ideas",
    "/recent - list recent thoughts",
    "/tasks - list recent tasks",
    "/stats - show thought stats",
    "/search <query> - search thoughts",
    "/save <text> - force-save a thought",
    "",
    "Natural-language questions also work, for example:",
    '"what ideas do I have saved?"',
    '"show me my recent tasks"',
    '"what do I have about trading?"',
  ].join("\n");
}

function extractSearchQuery(normalizedText: string): string | null {
  const matchers = [
    /(?:search\s+for|find)\s+(.+)/,
    /what\s+do\s+i\s+have\s+(?:saved\s+)?about\s+(.+)/,
    /show\s+me\s+.*?about\s+(.+)/,
    /(?:thoughts|ideas|tasks|notes|observations)\s+about\s+(.+)/,
    /(?:thoughts|ideas|tasks|notes|observations)\s+on\s+(.+)/,
    /about\s+(.+)/,
    /on\s+(.+)/,
  ];

  for (const matcher of matchers) {
    const match = normalizedText.match(matcher);
    if (!match?.[1]) continue;

    const query = match[1]
      .replace(/[?.!]+$/g, "")
      .replace(/^(my|the)\s+/g, "")
      .trim();

    if (query) return query;
  }

  return null;
}

function detectIntent(rawText: string): AssistantIntent {
  const text = rawText.trim();
  const normalizedText = text.toLowerCase();

  if (!text) return { kind: "help" };
  if (normalizedText === "/help" || normalizedText === "help") return { kind: "help" };

  const explicitSave =
    normalizedText.startsWith("/save ") ||
    /^(save this|remember this|note this|please save this|add this to open brain|store this)(\b|:)/.test(
      normalizedText,
    );

  if (explicitSave) {
    const content = normalizedText.startsWith("/save ") ? text.slice(6).trim() : text;
    return content ? { kind: "capture", content } : { kind: "help" };
  }

  if (normalizedText === "/ideas") return { kind: "list", limit: 25, type: "idea" };
  if (normalizedText === "/recent") return { kind: "list", limit: 25 };
  if (normalizedText === "/tasks") return { kind: "list", limit: 25, type: "task" };
  if (normalizedText === "/stats") return { kind: "stats" };
  if (normalizedText.startsWith("/search ")) {
    const query = text.slice(8).trim();
    return query ? { kind: "search", query, limit: 25 } : { kind: "help" };
  }

  if (/\b(stats|statistics|how many|count)\b/.test(normalizedText)) {
    return { kind: "stats" };
  }

  const retrievalCue =
    /\?|^(what|which|show|list|find|search|do i have|tell me|give me)\b/.test(normalizedText) ||
    /\b(saved|stored|remember|open brain|openbrain|recent|latest|currently|ideas|thoughts|tasks|notes|observations)\b/.test(
      normalizedText,
    );

  if (retrievalCue) {
    const query = extractSearchQuery(normalizedText);

    if (/\bideas?\b/.test(normalizedText) && !query) return { kind: "list", limit: 25, type: "idea" };
    if (/\btasks?\b/.test(normalizedText) && !query) return { kind: "list", limit: 25, type: "task" };
    if (/\bobservations?\b/.test(normalizedText) && !query) {
      return { kind: "list", limit: 25, type: "observation" };
    }
    if (/\b(recent|latest|currently|current)\b/.test(normalizedText) && !query) {
      return { kind: "list", limit: 25 };
    }
    if (query) return { kind: "search", query, limit: 25 };
    return { kind: "list", limit: 25 };
  }

  return { kind: "assistant" };
}

async function claimUpdate(update: TelegramUpdate, message: TelegramMessage): Promise<boolean> {
  const { error } = await supabase.from("telegram_capture_events").insert({
    update_id: update.update_id,
    chat_id: message.chat.id,
    message_id: message.message_id,
  });

  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

async function releaseUpdate(updateId: number): Promise<void> {
  const { error } = await supabase.from("telegram_capture_events").delete().eq("update_id", updateId);

  if (error) console.error("Failed to release claimed update:", updateId, error);
}

async function upsertChatState(chatId: number, patch: Partial<ChatState>): Promise<void> {
  const { error } = await supabase.from("telegram_chat_state").upsert(
    {
      chat_id: chatId,
      active_summary: patch.active_summary ?? "",
      preferences: patch.preferences ?? {},
      last_summary_at: patch.last_summary_at ?? null,
      last_active_at: patch.last_active_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chat_id" },
  );

  if (error) throw error;
}

async function loadChatState(chatId: number): Promise<ChatState> {
  const { data, error } = await supabase
    .from("telegram_chat_state")
    .select("chat_id, active_summary, preferences, last_summary_at, last_active_at")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) throw error;

  return {
    chat_id: chatId,
    active_summary: data?.active_summary ?? "",
    preferences: (data?.preferences as Record<string, unknown>) ?? {},
    last_summary_at: data?.last_summary_at ?? null,
    last_active_at: data?.last_active_at ?? null,
  };
}

async function storeChatMessage(
  chatId: number,
  role: ChatRole,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.from("telegram_chat_messages").insert({
    chat_id: chatId,
    role,
    content,
    metadata,
  });

  if (error) throw error;
}

async function loadRecentChatMessages(chatId: number, limit: number): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from("telegram_chat_messages")
    .select("role, content, created_at, metadata")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      role: row.role as ChatRole,
      content: row.content,
      created_at: row.created_at,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    }));
}

function formatRecentMessages(messages: StoredMessage[]): string {
  return messages
    .map((message) => {
      const time = new Date(message.created_at).toISOString();
      const label = message.role === "tool" ? `tool:${String(message.metadata.tool_name ?? "tool")}` : message.role;
      return `[${time}] ${label}: ${message.content}`;
    })
    .join("\n");
}

function buildAssistantSystemPrompt(): string {
  return [
    "You are the Open Brain Telegram assistant.",
    "Help the user talk naturally, retrieve saved thoughts, and save new thoughts only when explicitly asked.",
    "Rules:",
    "- Never save a thought unless the user explicitly asks you to save or remember it.",
    "- If something sounds like a useful idea but is not explicit, answer normally and suggest saving it.",
    "- Use tools when needed for search, list, stats, or save.",
    "- Be concise, useful, and friendly.",
    "- If the user asks for many results, return them or continue in chunks.",
    "- Treat chat memory as temporary context only.",
    "- Do not invent saved memories.",
  ].join("\n");
}

function formatOpenRouterMessages(state: ChatState, recentMessages: StoredMessage[], userText: string): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [{ role: "system", content: buildAssistantSystemPrompt() }];

  if (state.active_summary.trim()) {
    messages.push({
      role: "system",
      content: ["Temporary Telegram chat memory summary:", state.active_summary.trim()].join("\n"),
    });
  }

  if (recentMessages.length > 0) {
    messages.push({
      role: "system",
      content: ["Recent Telegram context:", formatRecentMessages(recentMessages)].join("\n"),
    });
  }

  messages.push({ role: "user", content: userText });
  return messages;
}

function parseJsonArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clipForModel(text: string, maxChars = MAX_MODEL_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Output truncated for model context.]`;
}

async function parseMcpResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const json = await response.json();
    const text = json?.result?.content?.[0]?.text;
    if (typeof text === "string" && text.length > 0) return text;
    throw new Error(`Unexpected MCP JSON response: ${JSON.stringify(json)}`);
  }

  const raw = await response.text();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;

    const payload = line.slice(6);
    try {
      const json = JSON.parse(payload);
      const text = json?.result?.content?.[0]?.text;
      if (typeof text === "string" && text.length > 0) return text;
    } catch {
      // Ignore malformed non-JSON lines and keep scanning.
    }
  }

  throw new Error(`Unexpected MCP SSE response: ${raw}`);
}

async function callOpenBrainTool(name: string, args: Record<string, unknown>): Promise<string> {
  const url = `${OPENBRAIN_MCP_URL}?key=${encodeURIComponent(OPENBRAIN_MCP_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Open Brain MCP request failed (${response.status}): ${body}`);
  }

  return await parseMcpResponse(response);
}

async function callOpenRouterChat(
  messages: OpenRouterMessage[],
  tools: typeof MCP_TOOL_SCHEMAS = MCP_TOOL_SCHEMAS,
): Promise<OpenRouterResponseMessage> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is missing");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/rafaelmocelin/openbrain-telegram-capture",
      "X-Title": "Open Brain Telegram Capture",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.3,
      max_tokens: 900,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const json = await response.json();
  const message = json?.choices?.[0]?.message;

  if (!message) {
    throw new Error(`Unexpected OpenRouter response: ${JSON.stringify(json)}`);
  }

  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    tool_calls: Array.isArray(message.tool_calls) ? (message.tool_calls as OpenRouterToolCall[]) : [],
  };
}

function buildFinalThoughtContent(message: TelegramMessage, rawText: string): string {
  return buildThoughtContent(message, rawText);
}

async function runAssistantTool(name: string, args: Record<string, unknown>, message: TelegramMessage): Promise<string> {
  switch (name) {
    case "capture_thought": {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) throw new Error("capture_thought requires content");
      const captureResult = await callOpenBrainTool("capture_thought", {
        content: buildFinalThoughtContent(message, content),
      });
      return captureResult;
    }
    case "search_thoughts":
      return await callOpenBrainTool("search_thoughts", {
        query: String(args.query ?? "").trim(),
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 25,
        ...(args.threshold !== undefined ? { threshold: Number(args.threshold) } : {}),
      });
    case "list_thoughts":
      return await callOpenBrainTool("list_thoughts", {
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 25,
        ...(args.type ? { type: String(args.type) } : {}),
        ...(args.topic ? { topic: String(args.topic) } : {}),
        ...(args.person ? { person: String(args.person) } : {}),
        ...(args.days !== undefined ? { days: Number(args.days) } : {}),
      });
    case "thought_stats":
      return await callOpenBrainTool("thought_stats", {});
    default:
      throw new Error(`Unsupported tool: ${name}`);
  }
}

function toOpenRouterToolMessage(toolCall: OpenRouterToolCall, content: string): OpenRouterMessage {
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: clipForModel(content),
  } as OpenRouterMessage;
}

async function runOpenRouterAssistant(
  message: TelegramMessage,
  chatState: ChatState,
  recentMessages: StoredMessage[],
  userText: string,
): Promise<string> {
  const messages = formatOpenRouterMessages(chatState, recentMessages, userText);

  for (let round = 0; round < MAX_ASSISTANT_ROUNDS; round++) {
    const assistantMessage = await callOpenRouterChat(messages);

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: assistantMessage.tool_calls,
      });

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const args = parseJsonArguments(toolCall.function.arguments);
        const result = await runAssistantTool(toolName, args, message);
        messages.push(toOpenRouterToolMessage(toolCall, result));
      }

      continue;
    }

    const finalText = (assistantMessage.content ?? "").trim();
    if (finalText) return finalText;
    return "I’m here, but I need a bit more detail to answer that.";
  }

  return "I hit the tool-calling limit. Try a narrower question or ask me to search or list something specific.";
}

async function directAssistantReply(intent: AssistantIntent, message: TelegramMessage): Promise<string> {
  switch (intent.kind) {
    case "help":
      return buildHelpText();
    case "stats":
      return await callOpenBrainTool("thought_stats", {});
    case "list": {
      const args: Record<string, unknown> = { limit: intent.limit };
      if (intent.type) args.type = intent.type;
      if (intent.days !== undefined) args.days = intent.days;
      return await callOpenBrainTool("list_thoughts", args);
    }
    case "search":
      return await callOpenBrainTool("search_thoughts", {
        query: intent.query,
        limit: intent.limit,
      });
    case "capture": {
      const captureResult = await callOpenBrainTool("capture_thought", {
        content: buildFinalThoughtContent(message, intent.content),
      });
      return `Captured to Open Brain\n${captureResult}`;
    }
    case "assistant":
      throw new Error("assistant intent must be handled by the OpenRouter assistant path");
  }
}

async function maybeSummarizeChatMemory(chatId: number): Promise<ChatState> {
  const state = await loadChatState(chatId);
  const cutoff = new Date(Date.now() - CHAT_MEMORY_DAYS * 24 * 60 * 60 * 1000);
  const lastSummaryBoundary = state.last_summary_at ? new Date(state.last_summary_at) : null;

  let query = supabase
    .from("telegram_chat_messages")
    .select("role, content, created_at, metadata")
    .eq("chat_id", chatId)
    .lt("created_at", cutoff.toISOString())
    .order("created_at", { ascending: true });

  if (lastSummaryBoundary) {
    query = query.gt("created_at", lastSummaryBoundary.toISOString());
  }

  const { data, error } = await query;
  if (error) throw error;

  const oldMessages = (data ?? []).map((row) => ({
    role: row.role as ChatRole,
    content: row.content,
    created_at: row.created_at,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  }));

  if (oldMessages.length === 0) return state;

  const existingSummary = state.active_summary.trim();
  const summaryPrompt = [
    "Summarize this Telegram conversation history for future assistant memory.",
    "Keep it compact and preserve:",
    "- ongoing projects",
    "- user preferences",
    "- unresolved follow-ups",
    "- important facts that help future conversation",
    "Do not include raw logs. Do not invent details.",
    "",
    existingSummary ? `Existing summary:\n${existingSummary}` : "Existing summary: (none)",
    "",
    "Messages to compress:",
    formatRecentMessages(oldMessages),
  ].join("\n");

  const summaryResponse = await callOpenRouterChat([
    { role: "system", content: "You compress Telegram chat memory into a short durable summary." },
    { role: "user", content: summaryPrompt },
  ], []);

  const summaryText = (summaryResponse.content ?? "").trim();
  if (!summaryText) return state;

  const periodStart = oldMessages[0]?.created_at ?? cutoff.toISOString();
  const periodEnd = oldMessages[oldMessages.length - 1]?.created_at ?? cutoff.toISOString();

  const { error: summaryInsertError } = await supabase.from("telegram_chat_summaries").insert({
    chat_id: chatId,
    period_start: periodStart,
    period_end: periodEnd,
    summary: summaryText,
  });

  if (summaryInsertError) throw summaryInsertError;

  const { error: deleteError } = await supabase
    .from("telegram_chat_messages")
    .delete()
    .eq("chat_id", chatId)
    .lt("created_at", cutoff.toISOString());

  if (deleteError) throw deleteError;

  await upsertChatState(chatId, {
    chat_id: chatId,
    active_summary: summaryText,
    preferences: state.preferences,
    last_summary_at: cutoff.toISOString(),
    last_active_at: new Date().toISOString(),
  } as ChatState);

  return loadChatState(chatId);
}

function hasValidWebhookSecret(request: Request): boolean {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  return secret === TELEGRAM_WEBHOOK_SECRET;
}

function splitTelegramText(text: string, maxLength = MAX_TELEGRAM_CHUNK): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < Math.floor(maxLength * 0.4)) cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.4)) cut = maxLength;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendTelegramMessage(
  message: TelegramMessage,
  text: string,
  replyToOriginal = true,
): Promise<void> {
  const parts = splitTelegramText(text);

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const payload: Record<string, unknown> = {
      chat_id: message.chat.id,
      text: part,
      allow_sending_without_reply: true,
    };

    if (replyToOriginal && index === 0) {
      payload.reply_to_message_id = message.message_id;
    }

    if (message.message_thread_id) {
      payload.message_thread_id = message.message_thread_id;
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("Telegram reply failed:", response.status, body);
    }
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  let claimedUpdateId: number | null = null;
  let processed = false;

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!hasValidWebhookSecret(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    const message = getMessageFromUpdate(update);

    if (!message) return new Response("ok", { status: 200 });

    const chatId = String(message.chat.id);
    if (!allowedChatIds.has(chatId)) {
      console.warn("Ignoring message from unauthorized chat", chatId);
      return new Response("ok", { status: 200 });
    }

    const messageText = getMessageText(message);
    if (!messageText) {
      await sendTelegramMessage(message, "Text messages and captions are supported for now.");
      return new Response("ok", { status: 200 });
    }

    const isNewUpdate = await claimUpdate(update, message);
    if (!isNewUpdate) return new Response("ok", { status: 200 });
    claimedUpdateId = update.update_id;

    const intent = detectIntent(messageText);
    const activeState = await maybeSummarizeChatMemory(message.chat.id);
    const recentMessages = await loadRecentChatMessages(message.chat.id, RECENT_CONTEXT_MESSAGES);

    await storeChatMessage(message.chat.id, "user", messageText, {
      update_id: update.update_id,
      message_id: message.message_id,
      chat_id: message.chat.id,
      chat_type: message.chat.type,
    });

    await upsertChatState(message.chat.id, {
      chat_id: message.chat.id,
      active_summary: activeState.active_summary,
      preferences: activeState.preferences,
      last_summary_at: activeState.last_summary_at,
      last_active_at: new Date().toISOString(),
    } as ChatState);

    let replyText = "";

    if (intent.kind === "assistant") {
      replyText = await runOpenRouterAssistant(message, activeState, recentMessages, messageText);
    } else {
      replyText = await directAssistantReply(intent, message);
    }

    await storeChatMessage(message.chat.id, "assistant", replyText, {
      source: intent.kind,
      update_id: update.update_id,
      message_id: message.message_id,
    });

    processed = true;

    try {
      await sendTelegramMessage(message, replyText);
    } catch (replyError) {
      console.error("telegram-capture reply error:", replyError);
    }

    return new Response("ok", { status: 200 });
  } catch (error) {
    if (claimedUpdateId !== null && !processed) {
      await releaseUpdate(claimedUpdateId);
    }

    console.error("telegram-capture error:", error);
    return new Response("error", { status: 500 });
  }
});
