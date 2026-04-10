# Open Brain Telegram Capture

Telegram capture and assistant layer for Open Brain, backed by Supabase Edge Functions, OpenRouter, and MCP tools.

This repo now contains both sides of the integration:

- `telegram-capture`: receives Telegram webhooks, uses an LLM as the orchestrator, and replies back in Telegram
- `open-brain-mcp`: exposes the Open Brain tools that actually save, search, list, and update thoughts

## What It Does

- Captures Telegram text messages and captions into Open Brain
- Uses an LLM orchestrator to decide whether a message should save, search, list, update, or route to assistant chat
- Preserves explicit user framing like `recipe`, `prompt`, `framework`, or `checklist` instead of collapsing everything into a fixed small label set
- Supports marking tasks done and keeps completion history in metadata
- Defaults task retrieval to active tasks, while still allowing completed-task queries
- Stores lightweight Telegram chat memory in Supabase and compacts older history into summaries
- Acknowledges Telegram webhooks immediately, then finishes model/tool work in the background to avoid webhook timeout failures

## Current Architecture

```text
Telegram Bot
  -> Supabase Edge Function: telegram-capture
  -> OpenRouter orchestration / assistant calls
  -> Supabase Edge Function: open-brain-mcp
  -> thoughts table + vector search RPCs
  -> Telegram reply
```

## Important Design Choices

- The LLM is the orchestrator. Routing is not primarily regex-driven.
- Done tasks stay in the main `thoughts` table. Retrieval filtering, not table splitting, keeps context clean.
- Telegram webhook requests return quickly. The bot does the heavier orchestration and MCP work after the webhook has already been acknowledged.
- `open-brain-mcp` uses its own access key layer and must be deployed with `--no-verify-jwt` so Supabase does not block the request before custom auth runs.

## Repository Layout

- `README.md`
  This guide
- `.env.example`
  Example environment values for the Telegram function
- `metadata.json`
  Project metadata
- `supabase/config.toml`
  Supabase CLI project config used in this repo
- `supabase/functions/telegram-capture/index.ts`
  Telegram webhook handler and LLM orchestration layer
- `supabase/functions/open-brain-mcp/index.ts`
  MCP server with capture, search, list, stats, and update tools
- `supabase/migrations/20260406175603_telegram_capture_events.sql`
  Deduplication table migration
- `supabase/migrations/20260406193000_telegram_chat_memory.sql`
  Telegram memory tables migration
- `supabase/sql/telegram_capture_events.sql`
  SQL version of the deduplication table

## Prerequisites

You need:

- a Supabase project
- Supabase CLI
- a Telegram bot token from `@BotFather`
- an OpenRouter API key
- an existing Open Brain database shape with:
  - `thoughts`
  - `match_thoughts` RPC
  - `upsert_thought` RPC

This repo is not a full Open Brain database bootstrap from zero. It assumes you already have the Open Brain storage and vector-search pieces available.

## Supported Behavior

- Private chat capture
- Group, supergroup, or channel ingestion if the chat ID is allowlisted and Telegram is configured to deliver those messages
- Text messages and captions
- Natural-language save requests
- Natural-language list and search requests
- Natural-language task completion requests
- Type corrections through `update_thought`
- Semantic updates using fuzzy matching rather than exact text matching
- Task status-aware retrieval

Examples:

- `save this idea: test a new newsletter format`
- `save this recipe: crispy roast potatoes with garlic and rosemary`
- `mark the dashboard task as done`
- `show my tasks`
- `show my completed tasks`
- `what ideas do I have about pricing?`

## Not Included Yet

- voice note transcription
- audio transcription
- image OCR
- file ingestion

## Required Secrets

### `telegram-capture`

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `OPENBRAIN_MCP_URL`
- `OPENBRAIN_MCP_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`

### `open-brain-mcp`

- `MCP_ACCESS_KEY`
- `OPENROUTER_API_KEY`

### Supabase-provided at runtime

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Secret Meanings

- `TELEGRAM_BOT_TOKEN`
  Telegram bot token from `@BotFather`
- `TELEGRAM_WEBHOOK_SECRET`
  Secret Telegram sends in `X-Telegram-Bot-Api-Secret-Token`
- `TELEGRAM_ALLOWED_CHAT_IDS`
  Comma-separated allowed chat IDs
- `OPENBRAIN_MCP_URL`
  URL of the deployed `open-brain-mcp` function, without query params
- `OPENBRAIN_MCP_KEY`
  Access key the Telegram function uses to call `open-brain-mcp`
- `MCP_ACCESS_KEY`
  Access key the MCP server expects via `x-brain-key` or `?key=`
- `OPENROUTER_API_KEY`
  Used for orchestration, assistant calls, metadata extraction, and embeddings
- `OPENROUTER_MODEL`
  Chat model for the Telegram assistant and orchestrator. Defaults to `google/gemini-3-flash-preview`

## Example Environment Values

`.env.example` currently contains:

```env
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
TELEGRAM_WEBHOOK_SECRET=replace-with-random-secret-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1001234567890
OPENBRAIN_MCP_URL=https://your-project.supabase.co/functions/v1/open-brain-mcp
OPENBRAIN_MCP_KEY=replace-with-your-openbrain-key
OPENROUTER_API_KEY=replace-with-your-openrouter-key
OPENROUTER_MODEL=google/gemini-3-flash-preview
```

For `open-brain-mcp`, also set:

```env
MCP_ACCESS_KEY=replace-with-your-mcp-access-key
```

## Step 1: Create the Telegram Bot

1. Open Telegram.
2. Chat with `@BotFather`.
3. Run `/newbot`.
4. Choose a display name and username.
5. Save the bot token.

If you want the bot to read regular group messages, disable privacy mode in BotFather.

## Step 2: Get the Allowed Chat ID

Before setting the webhook, send a message to the bot and inspect updates:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
```

Copy the `chat.id` you want to allow.

Examples:

- private chat: `123456789`
- group: `-987654321`
- supergroup: `-1001234567890`

If a webhook is already active, temporarily clear it first:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{"drop_pending_updates":false}'
```

## Step 3: Create the Telegram Support Tables

Apply the deduplication migration:

```sql
create table if not exists public.telegram_capture_events (
  update_id bigint primary key,
  chat_id bigint not null,
  message_id bigint,
  processed_at timestamptz not null default now()
);
```

This exists in:

- `supabase/migrations/20260406175603_telegram_capture_events.sql`
- `supabase/sql/telegram_capture_events.sql`

Apply the chat memory migration too:

- `supabase/migrations/20260406193000_telegram_chat_memory.sql`

It creates:

- `telegram_chat_state`
- `telegram_chat_messages`
- `telegram_chat_summaries`

## Step 4: Configure Supabase CLI

If you are using this repo directly:

```bash
supabase link --project-ref <YOUR_PROJECT_REF>
```

If you fork this repo for another project, update `supabase/config.toml` to your own project ref or regenerate it with `supabase init` and `supabase link`.

## Step 5: Set Secrets

Example:

```bash
supabase secrets set TELEGRAM_BOT_TOKEN="your-bot-token"
supabase secrets set TELEGRAM_WEBHOOK_SECRET="your_webhook_secret"
supabase secrets set TELEGRAM_ALLOWED_CHAT_IDS="123456789"
supabase secrets set OPENBRAIN_MCP_URL="https://your-project.supabase.co/functions/v1/open-brain-mcp"
supabase secrets set OPENBRAIN_MCP_KEY="your-mcp-access-key"
supabase secrets set MCP_ACCESS_KEY="your-mcp-access-key"
supabase secrets set OPENROUTER_API_KEY="your-openrouter-key"
supabase secrets set OPENROUTER_MODEL="google/gemini-3-flash-preview"
```

Telegram webhook secret tokens should use Telegram-safe characters. Stick to letters, numbers, `_`, and `-`.

Example generator:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

## Step 6: Deploy Both Functions

Deploy `open-brain-mcp` with JWT verification disabled.

This is important. Without `--no-verify-jwt`, Supabase will reject requests with a platform-level `401 Missing authorization header` before the function can check `MCP_ACCESS_KEY`.

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy telegram-capture --no-verify-jwt
```

## Step 7: Register the Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-capture",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "channel_post"],
    "drop_pending_updates": true
  }'
```

Check status:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

## How Message Handling Works

### Telegram webhook flow

1. Telegram sends an update to `telegram-capture`.
2. The function verifies `X-Telegram-Bot-Api-Secret-Token`.
3. It rejects unauthorized chat IDs.
4. It claims `update_id` in `telegram_capture_events` to prevent duplicate processing.
5. It immediately returns `200 OK` to Telegram.
6. Background processing continues with orchestration, MCP tool calls, and Telegram reply.

This background-processing behavior is what keeps the LLM-enabled version reliable under webhook timing constraints.

### Orchestration flow

The `telegram-capture` function asks the LLM to return a structured plan with one of these actions:

- `help`
- `save`
- `update`
- `query`
- `search`
- `assistant`

That plan can include:

- cleaned save content
- `type_override`
- multiple save items
- update intent such as `mark_done`
- query or search filters such as `status=done`

### Storage behavior

Saved thoughts are stored with Telegram source context appended, for example:

```text
Need to review onboarding flow copy tomorrow.

[Source: Telegram | Chat: private:@yourusername | From: @yourusername | Message ID: 42 | Sent At: 2026-04-10T12:00:00.000Z]
```

## Current MCP Tool Behavior

### `capture_thought`

- generates embeddings
- extracts metadata with an LLM
- preserves explicit user type labels via `type_override`
- defaults tasks to `status: pending`

### `search_thoughts`

- semantic search
- optional filters for `type`, `status`, and `include_done`
- task searches exclude done tasks by default unless explicitly requested

### `list_thoughts`

- optional filters for `type`, `status`, `include_done`, `topic`, `person`, and `days`
- task lists default to active tasks only
- done tasks can still be listed explicitly

### `update_thought`

- uses semantic matching to find the target thought
- can change type
- can mark tasks `done`
- adds `completed_at` when status becomes `done`
- removes `completed_at` if status changes away from `done`

## Task Handling Model

Done tasks are not moved to a separate table.

Instead:

- tasks stay in `thoughts`
- `metadata.status` tracks `pending`, `in_progress`, or `done`
- `metadata.completed_at` is recorded when a task is completed
- task retrieval defaults to active tasks so completed work does not pollute normal task views

This keeps history intact without increasing LLM context unless done items are explicitly retrieved.

## Local and Direct HTTP Testing

You can test the Telegram webhook without waiting for Telegram:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-capture" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: YOUR_WEBHOOK_SECRET" \
  -d '{
    "update_id": 10001,
    "message": {
      "message_id": 42,
      "date": 1775499600,
      "chat": {
        "id": 123456789,
        "type": "private",
        "username": "yourusername",
        "first_name": "Your"
      },
      "from": {
        "id": 123456789,
        "is_bot": false,
        "username": "yourusername",
        "first_name": "Your"
      },
      "text": "show my completed tasks"
    }
  }'
```

You can probe the MCP server directly too:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp?key=YOUR_MCP_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_thoughts",
      "arguments": { "type": "task" }
    }
  }'
```

## Troubleshooting

### Telegram webhook shows `500 Internal Server Error`

Check:

- the deployed webhook URL is correct
- the webhook secret matches exactly
- the latest `telegram-capture` code is deployed
- `getWebhookInfo` for pending updates and last error details

### MCP calls fail with `401 Missing authorization header`

Your `open-brain-mcp` function was probably deployed without `--no-verify-jwt`.

Redeploy:

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
```

### Telegram replies with `Invalid or missing access key`

Check that:

- `OPENBRAIN_MCP_KEY` in `telegram-capture` matches `MCP_ACCESS_KEY` in `open-brain-mcp`
- the MCP URL is correct

### Messages arrive but the bot ignores them

Check:

- the chat ID is in `TELEGRAM_ALLOWED_CHAT_IDS`
- the incoming update includes `text` or `caption`
- for groups, the bot has access to the message and privacy mode is configured correctly

### `getUpdates` returns nothing

A webhook is probably active. Telegram only uses one delivery mode at a time.

Temporarily clear it:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{"drop_pending_updates":false}'
```

### Type labels feel too generic

The current system prefers the core Open Brain labels by default, but it preserves more specific labels when the user clearly frames the item that way. If you want even stronger preservation for a category your workflow uses often, adjust the orchestration and metadata prompts together in:

- `supabase/functions/telegram-capture/index.ts`
- `supabase/functions/open-brain-mcp/index.ts`

## What I Would Update Next

If you want to keep improving this repo, the highest-value next steps are:

1. Add real end-to-end tests for webhook payloads and MCP tool calls.
2. Add voice and image ingestion.
3. Add richer task lifecycle operations such as reopening or bulk task workflows.
4. Add more explicit setup docs for the base Open Brain `thoughts` schema and RPCs.
5. Add a small architecture diagram image for the GitHub landing page.

## Summary

This repo is no longer just a thin Telegram wrapper. It is a working two-function Open Brain integration with:

- Telegram ingestion
- LLM orchestration
- semantic capture and retrieval
- flexible type labeling
- task completion tracking
- done-task filtering that protects normal task views
- webhook reliability fixes for production use

If you deploy both functions correctly and already have the base Open Brain database primitives, this repo gives you a practical Telegram inbox for your memory system.
