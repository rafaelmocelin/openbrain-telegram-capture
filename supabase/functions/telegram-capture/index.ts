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

type OrchestrationPlan =
  | { action: "help" }
  | { action: "save"; content?: string; type_override?: string; items?: string[] }
  | { action: "update"; content_query?: string; update_type?: "mark_done" | "change_type"; new_type?: string }
  | { action: "query"; query_type: "ideas" | "recent" | "tasks" | "stats"; query?: string; status?: string; include_done?: boolean }
  | { action: "search"; query: string; type?: string; status?: string; include_done?: boolean }
  | { action: "assistant" };

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

type BackgroundRuntime = {
  waitUntil?: (promise: Promise<unknown>) => void;
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
      description: "Save a thought into Open Brain. Use type_override to preserve the user's explicit framing, such as task, idea, recipe, reference, prompt, or framework.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The thought to capture." },
          type_override: { type: "string", description: "Short type label to preserve the user's explicit framing. Prefer core labels like observation, task, idea, reference, person_note, but use a more specific label like recipe or prompt when the user clearly asks for that kind of thing." },
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
          type: { type: "string", description: "Optional type filter, such as task, idea, reference, or recipe." },
          status: { type: "string", description: "Optional status filter, such as pending, in_progress, or done." },
          include_done: { type: "boolean", description: "Include done tasks. Task searches exclude done items by default unless status is set to done." },
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
          status: { type: "string", description: "Optional status filter, such as pending, in_progress, or done." },
          include_done: { type: "boolean", description: "Include done tasks. Task lists exclude done items by default unless status is set to done." },
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
      description: "Update an existing thought's metadata, change type (e.g., 'reference' to 'idea'), or mark a task as done.",
      parameters: {
        type: "object",
        properties: {
          content_query: { type: "string", description: "Text from the thought to identify it" },
          updates: {
            type: "object",
            properties: {
              type: { type: "string", description: "New type label. Prefer observation, task, idea, reference, or person_note unless a more specific label like recipe or prompt is intentionally desired." },
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

async function orchestrate(
  text: string,
  message: TelegramMessage,
  memory: ChatMemory,
): Promise<OrchestrationPlan> {
  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        "You orchestrate an Open Brain Telegram bot.",
        "Return a single JSON object that decides how the bot should handle the user's message.",
        "",
        "Allowed actions:",
        '- "help"',
        '- "save"',
        '- "update"',
        '- "query"',
        '- "search"',
        '- "assistant"',
        "",
        "JSON fields:",
        '- "action": required',
        '- "content": cleaned standalone thought content for save',
        '- "type_override": short type label that preserves the user\'s explicit framing when relevant',
        '- "items": array of cleaned save items only when user explicitly wants multiple separate items saved',
        '- "content_query": phrase to identify an existing thought for updates',
        '- "update_type": "mark_done" or "change_type"',
        '- "new_type": only for change_type updates',
        '- "query_type": "ideas", "recent", "tasks", or "stats" for list/stat requests',
        '- "status": optional status filter for query or search requests, such as pending, in_progress, or done',
        '- "include_done": optional boolean for query or search requests when the user explicitly wants done tasks included',
        '- "query": search text for search requests',
        "",
        "Rules:",
        "- Use save when the user is explicitly asking to capture/store/add/save something to Open Brain.",
        "- Use update when the user is explicitly changing status/type of an existing saved thought.",
        "- Use query for list-like requests such as ideas, recent items, tasks, or stats.",
        "- Use search for semantic retrieval questions about saved thoughts.",
        "- Use assistant for general conversation or analysis that is not an explicit save/update/list/search command.",
        "- Active tasks are the default. If the user asks for tasks without mentioning completed/done, prefer pending or in-progress tasks and leave done tasks out.",
        "- If the user explicitly asks for completed/done tasks, set status=done.",
        "- Prefer core type labels observation, task, idea, reference, and person_note by default.",
        "- If the user explicitly names the kind of thing being saved, preserve that framing in type_override, even when it is more specific than the core labels, such as recipe, prompt, framework, workout, or checklist.",
        "- Examples: 'save this recipe' -> action=save, type_override=recipe. 'save this prompt for later' -> action=save, type_override=prompt. 'save this as an idea' -> action=save, type_override=idea.",
        "- If multiple items are being saved separately, fill items and do not also include content.",
        "- Return valid JSON only. No markdown. No prose.",
      ].join("\n"),
    },
    {
      role: "system",
      content: `Chat context:\nFrom: ${describeSender(message) || "unknown"}\nChat type: ${message.chat.type}`,
    },
  ];

  if (memory.summary.trim()) {
    messages.push({ role: "system", content: `Memory summary:\n${memory.summary.trim()}` });
  }

  if (memory.recent.length > 0) {
    const recentText = memory.recent
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
      .join("\n");
    messages.push({ role: "system", content: `Recent context:\n${recentText}` });
  }

  messages.push({ role: "user", content: text });

  try {
    const result = await callOpenRouterChat(messages, false, [], 12000);
    const plan = JSON.parse(result.content);
    if (plan.action && typeof plan.action === "string") {
      return plan as OrchestrationPlan;
    }
  } catch (error) {
    console.error("Orchestrator error:", error);
  }

  if (!text.trim()) return { action: "help" };
  return { action: "assistant" };
}

function runInBackground(task: Promise<void>): void {
  const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: BackgroundRuntime }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(task);
    return;
  }

  task.catch((error) => {
    console.error("Background task failed:", error);
  });
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

async function callOpenBrainTool(name: string, args: Record<string, unknown>, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
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
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

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
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`MCP request to ${name} timed out`);
    }
    throw error;
  }
}

function buildAssistantSystemPrompt(): string {
  return [
    "You are the Open Brain Telegram assistant.",
    "Answer naturally and synthesize results instead of dumping raw tool output.",
    "Rules:",
    "- If a message is idea-like but not explicit, answer normally and suggest saving it.",
    "- Use tools when needed for search, list, stats, or save.",
    "- For saved-thought questions, search/list and summarize the results in plain language.",
    "- Keep replies concise and useful.",
    "- If the user asks for many results, chunk them or summarize them.",
    "- When the user asks to list, search, or query stored data in Open Brain, always use the available tools. Never answer from memory or conversation history.",
    "- Use list_thoughts for listing items (with appropriate filters like type, status, topic, days). Use search_thoughts for keyword searches. Use thought_stats for statistics.",
    "- Interpret the user's intent naturally - if they ask for 'tasks', filter by type=\"task\" and default to active tasks. If they ask for completed or done tasks, include status=\"done\".",
    "- When the user asks to mark something as done, complete, or finished, use the update_thought tool with status=\"done\".",
    "- When the user says something should be a different type (e.g., 'not a reference, save it as an idea'), use update_thought with the correct type.",
    "- When saving, preserve the user's explicit framing. If they call it a recipe, prompt, framework, or checklist, pass that as type_override instead of collapsing it into a generic bucket.",
    "- Do not save anything unless the user explicitly asks. Never claim something was saved if you did not call capture_thought.",
  ].join("\n");
}

async function callOpenRouterChat(
  messages: OpenRouterMessage[],
  allowTools = true,
  tools = MCP_TOOL_SCHEMAS,
  timeoutMs = 10000,
): Promise<{ content: string; toolCalls: OpenRouterToolCall[] }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
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
        max_tokens: allowTools ? 900 : 300,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

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
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  }
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

async function polishAssistantReply(userText: string, draft: string): Promise<string> {
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
  const system = buildAssistantSystemPrompt();
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

  messages.push({ role: "user", content: text });
  return await callAssistant(messages, message, ASSISTANT_TOOL_SCHEMAS);
}

async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  let claimedUpdateId: number | null = null;
  let message: TelegramMessage | null = null;

  try {
    message = getMessageFromUpdate(update);
    if (!message) return;

    const chatId = String(message.chat.id);
    if (!allowedChatIds.has(chatId)) {
      console.warn("Ignoring message from unauthorized chat", chatId);
      return;
    }

    const text = getMessageText(message);
    if (!text) {
      await sendTelegramReply(message, "Text messages and captions are supported.");
      return;
    }

    const { error: claimError } = await supabase.from("telegram_capture_events").insert({
      update_id: update.update_id,
      chat_id: message.chat.id,
      message_id: message.message_id,
    });

    if (claimError) {
      if (claimError.code === "23505") return;
      throw claimError;
    }

    claimedUpdateId = update.update_id;
    console.log("Processing message:", text.substring(0, 100));

    await compactChatMemory(message.chat.id);
    const memory = await loadChatMemory(message.chat.id);
    await recordChatMessage(message.chat.id, "user", text);

    const plan = await orchestrate(text, message, memory);
    console.log("Orchestrator plan:", JSON.stringify(plan));

    let replyText = "";

    if (plan.action === "help") {
      replyText = buildHelpText();
    } else if (plan.action === "save") {
      if (plan.items && plan.items.length > 0) {
        const results: string[] = [];
        for (const item of plan.items) {
          const captureArgs: Record<string, unknown> = { content: buildThoughtContent(message, item) };
          if (plan.type_override) captureArgs.type_override = plan.type_override;
          results.push(await callMcpDirect("capture_thought", captureArgs));
        }
        replyText = `Captured ${results.length} items to Open Brain:\n${results.join("\n")}`;
      } else if (plan.content) {
        const captureArgs: Record<string, unknown> = { content: buildThoughtContent(message, plan.content) };
        if (plan.type_override) captureArgs.type_override = plan.type_override;
        replyText = `Captured to Open Brain\n${await callMcpDirect("capture_thought", captureArgs)}`;
      } else {
        replyText = await polishAssistantReply(text, await handleAssistant(message, text));
      }
    } else if (plan.action === "update") {
      if (plan.update_type === "mark_done") {
        replyText = await callMcpDirect("update_thought", {
          content_query: plan.content_query || text,
          updates: { status: "done" },
        });
      } else if (plan.update_type === "change_type" && plan.new_type) {
        replyText = await callMcpDirect("update_thought", {
          content_query: plan.content_query || text,
          updates: { type: plan.new_type },
        });
      } else {
        replyText = await polishAssistantReply(text, await handleAssistant(message, text));
      }
    } else if (plan.action === "query") {
      if (plan.query_type === "ideas") {
        replyText = await callMcpDirect("list_thoughts", { limit: 25, type: "idea", status: plan.status, include_done: plan.include_done });
      } else if (plan.query_type === "recent") {
        replyText = await callMcpDirect("list_thoughts", { limit: 25, status: plan.status, include_done: plan.include_done });
      } else if (plan.query_type === "tasks") {
        replyText = await callMcpDirect("list_thoughts", { limit: 25, type: "task", status: plan.status, include_done: plan.include_done });
      } else {
        replyText = await callMcpDirect("thought_stats", {});
      }
    } else if (plan.action === "search") {
      replyText = await callMcpDirect("search_thoughts", {
        query: plan.query,
        limit: 25,
        type: plan.type,
        status: plan.status,
        include_done: plan.include_done,
      });
    } else {
      if (!isPrivateChat(message)) {
        replyText = [
          "AI chat is only enabled in private chat.",
          "Use a slash command here, or send me a direct message for assistant replies.",
        ].join("\n");
      } else {
        replyText = await polishAssistantReply(text, await handleAssistant(message, text));
      }
    }

    await recordChatMessage(message.chat.id, "assistant", replyText);
    await sendTelegramReply(message, replyText);
  } catch (error) {
    console.error("telegram-capture error:", error);

    if (claimedUpdateId !== null) {
      const { error: releaseError } = await supabase
        .from("telegram_capture_events")
        .delete()
        .eq("update_id", claimedUpdateId);

      if (releaseError) {
        console.error("Failed to release claimed update:", claimedUpdateId, releaseError);
      }
    }

    if (message) {
      const errorMsg = `Sorry, something went wrong: ${error instanceof Error ? error.message : String(error)}`;
      await sendTelegramReply(message, errorMsg);
    }
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!hasValidWebhookSecret(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update = await request.json() as TelegramUpdate;
    const task = processTelegramUpdate(update);
    const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: BackgroundRuntime }).EdgeRuntime;
    if (runtime?.waitUntil) {
      runInBackground(task);
    } else {
      await task;
    }
    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("telegram-capture request error:", error);
    return new Response("ok", { status: 200 });
  }
});
