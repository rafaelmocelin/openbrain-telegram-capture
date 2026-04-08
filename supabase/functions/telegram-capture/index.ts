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
  | { kind: "help" }
  | { kind: "save"; content: string }
  | { kind: "ideas" }
  | { kind: "recent" }
  | { kind: "tasks" }
  | { kind: "stats" }
  | { kind: "search"; query: string }
  | { kind: "mark_done"; content_query: string }
  | { kind: "assistant" };

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
};

type ChatMemory = {
  summary: string;
  recent: Array<{ role: "user" | "assistant"; content: string }>;
};

type StoredChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type ChatSummaryRow = {
  summary: string;
  covers_through: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const TELEGRAM_ALLOWED_CHAT_IDS = Deno.env.get("TELEGRAM_ALLOWED_CHAT_IDS")!;
const OPENBRAIN_MCP_URL = Deno.env.get("OPENBRAIN_MCP_URL")!;
const OPENBRAIN_MCP_KEY = Deno.env.get("OPENBRAIN_MCP_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "google/gemini-3-flash-preview";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const CHAT_MEMORY_RECENT_LIMIT = 8;
const CHAT_MEMORY_RETENTION_DAYS = 20;
const CHAT_MEMORY_COMPACTION_BATCH = 50;
const allowedChatIds = new Set(
  TELEGRAM_ALLOWED_CHAT_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const MCP_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "capture_thought",
      description: "Save a thought into Open Brain.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The thought to capture." },
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
      description: "Search saved thoughts semantically by keyword or topic.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
          threshold: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
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
      description: "List thoughts from Open Brain with optional filters by type, topic, person, or time.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
          type: { type: "string" },
          topic: { type: "string" },
          person: { type: "string" },
          days: { type: "integer", minimum: 1, maximum: 365 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "thought_stats",
      description: "Get thought statistics.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_thought",
      description: "Update an existing thought's metadata or mark a task as done.",
      parameters: {
        type: "object",
        properties: {
          content_query: { type: "string", description: "Text from the thought to identify it" },
          updates: {
            type: "object",
            properties: {
              status: { type: "string", description: "New status: 'pending', 'in_progress', 'done'" },
            },
          },
        },
        required: ["content_query", "updates"],
        additionalProperties: false,
      },
    },
  },
] as const;

const ASSISTANT_TOOL_SCHEMAS = MCP_TOOL_SCHEMAS.filter((tool) => tool.function.name !== "capture_thought");

const EXPLICIT_SAVE_PATTERNS = [
  /^(please\s+)?save\s+(this|that|it)\b/i,
  /^(please\s+)?save\s+this\s+(idea|thought|note|task|observation)\b/i,
  /^(please\s+)?remember\s+(this|that|it)\b/i,
  /^(please\s+)?add\s+(this|that|it)\s+to\s+(my\s+)?open\s*brain\b/i,
  /^(please\s+)?store\s+(this|that|it)\b/i,
  /^(please\s+)?capture\s+(this|that|it)\b/i,
  /\b(can|could|would)\s+you\s+(please\s+)?save\b/i,
  /\b(can|could|would)\s+you\s+(please\s+)?remember\b/i,
  /\badd\s+this\s+to\s+(my\s+)?open\s*brain\b/i,
  /\b(add|capture|save)\s+these\s+(as\s+)?(two\s+)?separate\s+(work\s+)?tasks?\b/i,
  /\bmake sure\s+(each|they|these)\s+(are\s+)?captured\s+separately\s+as\s+tasks?\b/i,
  /\b(add|capture|save)\s+(these|those)\s+as\s+(two\s+)?separate\s+(work\s+)?tasks?\b/i,
  /\bweren'?t\s+captured\b/i,
  /tasks?\s+weren'?t\s+(saved|captured|sent|stored)\b/i,
  /work\s*tasks?\s*:\s*\d+/i,
];

function getMessageFromUpdate(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.channel_post ?? null;
}

function getMessageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function isPrivateChat(message: TelegramMessage): boolean {
  return message.chat.type === "private";
}

function hasValidWebhookSecret(request: Request): boolean {
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === TELEGRAM_WEBHOOK_SECRET;
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

function looksLikeExplicitSaveRequest(text: string): boolean {
  return EXPLICIT_SAVE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

async function recordChatMessage(
  chatId: number,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const { error } = await supabase.from("telegram_chat_messages").insert({
    chat_id: chatId,
    role,
    content,
  });

  if (error) {
    console.error("Failed to record chat message:", error);
  }
}

async function loadChatMemory(chatId: number): Promise<ChatMemory> {
  const memory: ChatMemory = { summary: "", recent: [] };

  const summaryResult = await supabase
    .from("telegram_chat_summaries")
    .select("summary, covers_through")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (!summaryResult.error && summaryResult.data?.summary) {
    memory.summary = String(summaryResult.data.summary);
  }

  const recentResult = await supabase
    .from("telegram_chat_messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(CHAT_MEMORY_RECENT_LIMIT);

  if (!recentResult.error && Array.isArray(recentResult.data)) {
    memory.recent = recentResult.data
      .filter((row): row is { role: "user" | "assistant"; content: string } => {
        return (row.role === "user" || row.role === "assistant") && typeof row.content === "string";
      })
      .reverse();
  }

  return memory;
}

async function summarizeOldChatMessages(
  chatId: number,
  existingSummary: string,
  messages: StoredChatMessage[],
): Promise<string> {
  const transcript = messages
    .map((entry) => `[${entry.created_at}] ${entry.role.toUpperCase()}: ${entry.content}`)
    .join("\n");

  const summaryMessages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        "Summarize Telegram chat history for future assistant context.",
        "Preserve durable facts, user preferences, active projects, follow-up intentions, and unresolved questions.",
        "Do not include filler or line-by-line chronology.",
        "Return a compact plain-text summary only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        existingSummary.trim() ? `Existing summary:\n${existingSummary.trim()}` : "Existing summary: none",
        `Chat ID: ${chatId}`,
        "Older messages to merge:",
        transcript,
      ].join("\n\n"),
    },
  ];

  const result = await callOpenRouterChat(summaryMessages, false);
  const summary = result.content.trim();
  if (!summary) {
    throw new Error("OpenRouter returned an empty chat memory summary.");
  }

  return summary;
}

async function compactChatMemory(chatId: number): Promise<void> {
  try {
    const summaryResult = await supabase
      .from("telegram_chat_summaries")
      .select("summary, covers_through")
      .eq("chat_id", chatId)
      .maybeSingle();

    const existingSummary: ChatSummaryRow = {
      summary: !summaryResult.error && summaryResult.data?.summary ? String(summaryResult.data.summary) : "",
      covers_through:
        !summaryResult.error && typeof summaryResult.data?.covers_through === "string"
          ? summaryResult.data.covers_through
          : null,
    };

    const cutoffIso = new Date(Date.now() - CHAT_MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let oldMessagesQuery = supabase
      .from("telegram_chat_messages")
      .select("id, role, content, created_at")
      .eq("chat_id", chatId)
      .lte("created_at", cutoffIso)
      .order("created_at", { ascending: true })
      .limit(CHAT_MEMORY_COMPACTION_BATCH);

    if (existingSummary.covers_through) {
      oldMessagesQuery = oldMessagesQuery.gt("created_at", existingSummary.covers_through);
    }

    const oldMessagesResult = await oldMessagesQuery;
    if (oldMessagesResult.error || !Array.isArray(oldMessagesResult.data) || oldMessagesResult.data.length === 0) {
      return;
    }

    const messages = oldMessagesResult.data.filter((row): row is StoredChatMessage => {
      return typeof row.id === "number"
        && (row.role === "user" || row.role === "assistant")
        && typeof row.content === "string"
        && typeof row.created_at === "string";
    });

    if (messages.length === 0) return;

    const mergedSummary = await summarizeOldChatMessages(chatId, existingSummary.summary, messages);
    const coversThrough = messages[messages.length - 1].created_at;

    const { error: upsertError } = await supabase.from("telegram_chat_summaries").upsert({
      chat_id: chatId,
      summary: mergedSummary,
      covers_through: coversThrough,
      updated_at: new Date().toISOString(),
    });

    if (upsertError) {
      throw upsertError;
    }

    let deleteQuery = supabase
      .from("telegram_chat_messages")
      .delete()
      .eq("chat_id", chatId)
      .lte("created_at", coversThrough);

    if (existingSummary.covers_through) {
      deleteQuery = deleteQuery.gt("created_at", existingSummary.covers_through);
    }

    const { error: deleteError } = await deleteQuery;
    if (deleteError) {
      console.error("Failed to delete compacted Telegram chat messages:", deleteError);
    }
  } catch (error) {
    console.error("Failed to compact Telegram chat memory:", error);
  }
}

function buildHelpText(): string {
  return [
    "Open Brain Telegram assistant commands:",
    "/save <text> - force save a thought",
    "/ideas - list idea thoughts",
    "/recent - list recent thoughts",
    "/tasks - list task thoughts",
    "/stats - show thought stats",
    "/search <query> - search saved thoughts",
    "",
    "You can also say things like 'save this idea...' in private chat and the assistant will format it before saving.",
    "Plain messages in private chat go to Gemini first, which can search, summarize, answer, or suggest saving.",
    "In groups, use slash commands or message the bot directly in private chat.",
  ].join("\n");
}

function detectIntent(rawText: string): AssistantIntent {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  if (!text) return { kind: "help" };
  if (lower === "/help" || lower === "help") return { kind: "help" };

  if (lower.startsWith("/save ")) {
    const content = text.slice(6).trim();
    return content ? { kind: "save", content } : { kind: "help" };
  }

  if (lower === "/ideas") return { kind: "ideas" };
  if (lower === "/recent") return { kind: "recent" };
  if (lower === "/tasks") return { kind: "tasks" };
  if (lower === "/stats") return { kind: "stats" };
  if (lower.startsWith("/search ")) {
    const query = text.slice(8).trim();
    return query ? { kind: "search", query } : { kind: "help" };
  }

  if (/\b(mark|complete|finish)\b.*\b(done|complete|finished)\b/i.test(text)) {
    const content_query = text
      .replace(/\b(mark|please\s+mark|please|complete|finish|that|this|the|task|as|done|completed|finished)\b/gi, "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^[.,;:\-]+|[.,;:\-]+$/g, "");
    return { kind: "mark_done", content_query: content_query || text };
  }

  return { kind: "assistant" };
}

function parseJsonArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clipForTelegram(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < 800) splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < 800) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendTelegramReply(message: TelegramMessage, text: string): Promise<void> {
  const chunks = clipForTelegram(text);

  for (const [index, chunk] of chunks.entries()) {
    const payload: Record<string, unknown> = {
      chat_id: message.chat.id,
      text: chunk,
      disable_web_page_preview: true,
      allow_sending_without_reply: true,
    };

    if (index === 0) {
      payload.reply_to_message_id = message.message_id;
      if (message.message_thread_id) payload.message_thread_id = message.message_thread_id;
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

async function callOpenBrainTool(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${OPENBRAIN_MCP_URL}?key=${encodeURIComponent(OPENBRAIN_MCP_KEY)}`, {
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
    try {
      const json = JSON.parse(line.slice(6));
      const text = json?.result?.content?.[0]?.text;
      if (typeof text === "string" && text.length > 0) return text;
    } catch {
      // keep scanning
    }
  }

  throw new Error(`Unexpected MCP SSE response: ${raw}`);
}

function buildAssistantSystemPrompt(allowNaturalLanguageSave: boolean): string {
  const rules = [
    "You are the Open Brain Telegram assistant.",
    "Answer naturally and synthesize results instead of dumping raw tool output.",
    "Rules:",
    "- If a message is idea-like but not explicit, answer normally and suggest saving it.",
    "- Use tools when needed for search, list, stats, or save.",
    "- For saved-thought questions, search/list and summarize the results in plain language.",
    "- Keep replies concise and useful.",
    "- If the user asks for many results, chunk them or summarize them.",
    "- When the user asks to list, search, or query stored data in Open Brain, always use the available tools. Never answer from memory or conversation history.",
    "- Use list_thoughts for listing items (with appropriate filters like type, topic, days). Use search_thoughts for keyword searches. Use thought_stats for statistics.",
    "- Interpret the user's intent naturally - if they ask for 'tasks', filter by type=\"task\"; if they ask for 'recent items', use days filter; if they want everything, omit the filter.",
    "- When the user asks to mark something as done, complete, or finished, use the update_thought tool with status=\"done\".",
  ];

  if (allowNaturalLanguageSave) {
    rules.push(
      "- The user appears to be explicitly asking to save something.",
      "- You may use capture_thought if that is the best match for the request.",
      "- When using capture_thought, pass only the cleaned thought content to save. Telegram source metadata is added automatically.",
      "- Save each task/item as a separate thought when the user requests multiple items.",
    );
  } else {
    rules.push("- Do not save anything unless the user used /save in this turn.");
    rules.push("- Never claim something was saved if you did not call capture_thought.");
  }

  return rules.join("\n");
}

async function callOpenRouterChat(
  messages: OpenRouterMessage[],
  allowTools = true,
  tools = MCP_TOOL_SCHEMAS,
): Promise<{ content: string; toolCalls: OpenRouterToolCall[] }> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/rafaelmocelin/openbrain-telegram-capture",
      "X-Title": "Open Brain Telegram Assistant",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      ...(allowTools ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.3,
      max_tokens: 900,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const json = await response.json();
  const choice = json?.choices?.[0]?.message;
  if (!choice) throw new Error(`Unexpected OpenRouter response: ${JSON.stringify(json)}`);

  return {
    content: typeof choice.content === "string" ? choice.content : "",
    toolCalls: Array.isArray(choice.tool_calls) ? choice.tool_calls as OpenRouterToolCall[] : [],
  };
}

async function callAssistant(
  messages: OpenRouterMessage[],
  message: TelegramMessage,
  tools = ASSISTANT_TOOL_SCHEMAS,
): Promise<string> {
  const workingMessages = [...messages];

  for (let step = 0; step < 4; step++) {
    const result = await callOpenRouterChat(workingMessages, true, tools);
    if (result.toolCalls.length === 0) {
      return result.content.trim() || "I do not have a response for that yet.";
    }

    workingMessages.push({
      role: "assistant",
      content: result.content || "",
      tool_calls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      const toolArgs = parseJsonArguments(toolCall.function.arguments);
      const resolvedArgs = toolCall.function.name === "capture_thought"
        && typeof toolArgs.content === "string"
        && toolArgs.content.trim()
        ? { content: buildThoughtContent(message, toolArgs.content.trim()) }
        : toolArgs;
      const toolResult = await callOpenBrainTool(toolCall.function.name, resolvedArgs);
      workingMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResult,
      });
    }
  }

  return "I hit the tool-call limit while answering that.";
}

function looksLikeRawToolDump(text: string): boolean {
  return /^(Total thoughts:|No thoughts found matching|\d+ recent thought\(s\):|event: message|data: )/i.test(
    text.trim(),
  );
}

async function polishAssistantReply(userText: string, draft: string): Promise<string> {
  if (!looksLikeRawToolDump(draft)) return draft;

  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        "Rewrite the draft into a concise, natural Telegram assistant reply.",
        "Do not mention raw event formats or tool output structure.",
        "Keep the meaning, but make it sound like a helpful AI assistant.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `User message: ${userText}\n\nDraft reply:\n${draft}`,
    },
  ];

  try {
    const polished = await callOpenRouterChat(messages, false);
    return polished.content.trim() || draft;
  } catch {
    return draft;
  }
}

async function callMcpDirect(name: string, args: Record<string, unknown>): Promise<string> {
  return await callOpenBrainTool(name, args);
}

async function handleAssistant(message: TelegramMessage, text: string): Promise<string> {
  const allowNaturalLanguageSave = looksLikeExplicitSaveRequest(text);
  const system = buildAssistantSystemPrompt(allowNaturalLanguageSave);
  await compactChatMemory(message.chat.id);
  const memory = await loadChatMemory(message.chat.id);

  const messages: OpenRouterMessage[] = [{ role: "system", content: system }];

  if (memory.summary.trim()) {
    messages.push({ role: "system", content: `Temporary Telegram memory summary:\n${memory.summary.trim()}` });
  }

  if (memory.recent.length > 0) {
    const recentText = memory.recent
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
      .join("\n");
    messages.push({ role: "system", content: `Recent Telegram context:\n${recentText}` });
  }

  await recordChatMessage(message.chat.id, "user", text);
  messages.push({ role: "user", content: text });
  return await callAssistant(
    messages,
    message,
    allowNaturalLanguageSave ? MCP_TOOL_SCHEMAS : ASSISTANT_TOOL_SCHEMAS,
  );
}

async function rewriteThoughtForNaturalLanguageSave(
  text: string,
  memory: ChatMemory,
): Promise<string> {
  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        "The user is explicitly asking to save something to Open Brain.",
        "Rewrite the content into the cleaned thought that should be stored.",
        "Remove request phrasing like 'save this' or 'remember this'.",
        "Preserve the actual idea, task, note, or observation.",
        "If the user refers to earlier context, use the provided memory to resolve it when possible.",
        "Return only the final thought text to save. Do not add preamble, bullets, or quotes unless they are part of the thought.",
      ].join("\n"),
    },
  ];

  if (memory.summary.trim()) {
    messages.push({ role: "system", content: `Temporary Telegram memory summary:\n${memory.summary.trim()}` });
  }

  if (memory.recent.length > 0) {
    const recentText = memory.recent
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
      .join("\n");
    messages.push({ role: "system", content: `Recent Telegram context:\n${recentText}` });
  }

  messages.push({ role: "user", content: text });

  const result = await callOpenRouterChat(messages, false);
  const rewritten = result.content.trim();
  return rewritten || text;
}

async function handleNaturalLanguageSave(message: TelegramMessage, text: string): Promise<string> {
  await compactChatMemory(message.chat.id);
  const memory = await loadChatMemory(message.chat.id);
  await recordChatMessage(message.chat.id, "user", text);

  const numberedPattern = /^\d+\.\s*.+$/gm;
  const matches = text.match(numberedPattern);

  if (matches && matches.length > 1) {
    const results: string[] = [];
    for (const item of matches) {
      const cleanedItem = await rewriteThoughtForNaturalLanguageSave(item, memory);
      const result = await callMcpDirect("capture_thought", {
        content: buildThoughtContent(message, cleanedItem),
      });
      results.push(result);
    }
    const reply = `Captured ${results.length} items to Open Brain:\n${results.join("\n")}`;
    await recordChatMessage(message.chat.id, "assistant", reply);
    return reply;
  }

  const cleanedThought = await rewriteThoughtForNaturalLanguageSave(text, memory);
  const captureResult = await callMcpDirect("capture_thought", {
    content: buildThoughtContent(message, cleanedThought),
  });

  const reply = `Captured to Open Brain\n${captureResult}`;
  await recordChatMessage(message.chat.id, "assistant", reply);
  return reply;
}

Deno.serve(async (request: Request): Promise<Response> => {
  let claimedUpdateId: number | null = null;

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!hasValidWebhookSecret(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update = await request.json() as TelegramUpdate;
    const message = getMessageFromUpdate(update);
    if (!message) return new Response("ok", { status: 200 });

    const chatId = String(message.chat.id);
    if (!allowedChatIds.has(chatId)) {
      console.warn("Ignoring message from unauthorized chat", chatId);
      return new Response("ok", { status: 200 });
    }

    const text = getMessageText(message);
    if (!text) {
      await sendTelegramReply(message, "Text messages and captions are supported.");
      return new Response("ok", { status: 200 });
    }

    const { error: claimError } = await supabase.from("telegram_capture_events").insert({
      update_id: update.update_id,
      chat_id: message.chat.id,
      message_id: message.message_id,
    });

    if (claimError) {
      if (claimError.code === "23505") return new Response("ok", { status: 200 });
      throw claimError;
    }

    claimedUpdateId = update.update_id;

    const intent = detectIntent(text);
    let replyText = "";

    if (intent.kind === "help") {
      replyText = buildHelpText();
    } else if (intent.kind === "save") {
      const captureResult = await callMcpDirect("capture_thought", { content: buildThoughtContent(message, intent.content) });
      replyText = `Captured to Open Brain\n${captureResult}`;
    } else if (intent.kind === "ideas") {
      replyText = await callMcpDirect("list_thoughts", { limit: 25, type: "idea" });
    } else if (intent.kind === "recent") {
      replyText = await callMcpDirect("list_thoughts", { limit: 25 });
    } else if (intent.kind === "tasks") {
      replyText = await callMcpDirect("list_thoughts", { limit: 25, type: "task" });
    } else if (intent.kind === "stats") {
      replyText = await callMcpDirect("thought_stats", {});
    } else if (intent.kind === "search") {
      replyText = await callMcpDirect("search_thoughts", { query: intent.query, limit: 25 });
    } else if (intent.kind === "mark_done") {
      replyText = await callMcpDirect("update_thought", {
        content_query: intent.content_query,
        updates: { status: "done" },
      });
    } else {
      if (!isPrivateChat(message)) {
        replyText = [
          "AI chat is only enabled in private chat.",
          "Use a slash command here, or send me a direct message for assistant replies.",
        ].join("\n");
      } else if (looksLikeExplicitSaveRequest(text)) {
        replyText = await handleNaturalLanguageSave(message, text);
      } else {
        replyText = await handleAssistant(message, text);
        replyText = await polishAssistantReply(text, replyText);
        await recordChatMessage(message.chat.id, "assistant", replyText);
      }
    }

    await sendTelegramReply(message, replyText);
    return new Response("ok", { status: 200 });
  } catch (error) {
    if (claimedUpdateId !== null) {
      const { error: releaseError } = await supabase
        .from("telegram_capture_events")
        .delete()
        .eq("update_id", claimedUpdateId);

      if (releaseError) {
        console.error("Failed to release claimed update:", claimedUpdateId, releaseError);
      }
    }

    console.error("telegram-capture error:", error);
    return new Response("error", { status: 500 });
  }
});
