# Open Brain Telegram Capture

Add Telegram as a quick-capture interface and lightweight assistant for your Open Brain.

Send a message to a Telegram bot, route that message through a Supabase Edge Function, and either save it to Open Brain or answer using a model-backed assistant that can call your existing MCP tools.

This project is intentionally thin. It does not rebuild embedding, tagging, or storage logic inside the Telegram integration. Instead, it reuses your existing Open Brain MCP server as the single ingestion path.

## Architecture

`Telegram Bot -> Supabase Edge Function -> OpenRouter assistant -> Open Brain MCP tools -> Telegram reply`

## Why This Approach

- Keeps Telegram as a capture interface, not a second copy of Open Brain logic
- Reuses the Open Brain MCP server you already have working
- Keeps the Edge Function small and maintainable
- Avoids duplicating embedding and metadata logic in multiple systems

## Who This Is For

This guide is for someone who already has:

- a working Open Brain MCP server
- a Supabase project
- access to Telegram

If you can create a Telegram bot, deploy a Supabase Edge Function, and set environment secrets, you can implement this.

## What This Version Supports

- Private chat capture with your bot
- Group or supergroup capture if you allowlist the chat ID
- Text messages
- Captions on media messages
- Deduplication of Telegram webhook retries
- Confirmation replies in Telegram
- `/ideas`, `/recent`, `/tasks`, `/stats`, and `/search <query>` commands
- Natural-language retrieval like `what ideas do I have saved?`
- Conversational chat with temporary Supabase memory
- Save suggestions for idea-like messages

## What This Version Does Not Yet Support

- Voice note transcription
- Audio transcription
- Photo OCR
- File ingestion

Those are good follow-up improvements after the assistant path is working.

---

## Repository Contents

- `README.md`
  Full setup guide
- `.env.example`
  Example environment values
- `metadata.json`
  Project metadata
- `supabase/functions/telegram-capture/index.ts`
  Deployable Edge Function
- `supabase/migrations/20260406193000_telegram_chat_memory.sql`
  Chat memory tables and summaries
- `supabase/sql/telegram_capture_events.sql`
  Deduplication table SQL

---

## Credential Tracker

Copy this into a note and fill it in as you go.

```text
TELEGRAM CAPTURE -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Open Brain MCP base URL:     https://____________.supabase.co/functions/v1/open-brain-mcp
  Open Brain MCP key:          ____________

FROM YOUR SUPABASE SETUP
  Supabase project ref:        ____________
  Edge Function URL:           https://____________.supabase.co/functions/v1/telegram-capture

FROM TELEGRAM
  Bot username:                @____________
  Bot token:                   ____________
  Allowed chat ID:             ____________
  Webhook secret token:        ____________

--------------------------------------
```

---

## Prerequisites

You need all of the following before you start:

- A working Open Brain MCP server with `capture_thought`, `search_thoughts`, `list_thoughts`, and `thought_stats`
- A Supabase project
- Supabase CLI installed and working
- A Telegram account
- Permission to create Telegram bots using `@BotFather`
- An OpenRouter API key for the conversational assistant

## Cost

Telegram bots are free.

This integration reuses your existing Open Brain capture pipeline, and only the conversational assistant uses OpenRouter. Deterministic commands like `/save`, `/ideas`, and `/search` bypass the model, which keeps token usage down.

The assistant also stores temporary Telegram chat memory in Supabase and compresses older raw chat rows into summaries after 20 days.

---

## Step 1: Create the Telegram Bot

1. Open Telegram.
2. Start a chat with `@BotFather`.
3. Send `/newbot`.
4. Follow the prompts:
   - choose a display name
   - choose a username ending in `bot`
5. Copy the bot token immediately.

It will look something like this:

```text
123456789:AAExampleTokenFromBotFather
```

Save it in your credential tracker.

### Recommended Bot Settings

If you only want to capture messages in a private chat with the bot, the default settings are fine.

If you want the bot to capture ordinary messages inside a group, you should usually disable bot privacy mode.

To do that:

1. In `@BotFather`, send `/mybots`
2. Choose your bot
3. Choose **Bot Settings**
4. Choose **Group Privacy**
5. Disable privacy mode

If privacy mode stays enabled, Telegram may only send the bot messages that explicitly mention it or use slash commands.

---

## Step 2: Decide Where Capture Will Happen

You have three common options.

### Option A: Private Chat with the Bot

Best first version.

- open a chat with the bot
- send it a message like `test`
- use that chat as your capture inbox

### Option B: Group or Supergroup

Useful for shared capture.

- add the bot to the group
- disable privacy mode if you want it to see normal messages
- send a test message in the group

### Option C: Channel

Possible, but usually less convenient for quick personal capture. If you are building this for yourself, start with a private chat.

---

## Step 3: Get the Allowed Chat ID

The function should only accept messages from trusted chats. The simplest model is to allowlist specific chat IDs.

### Easiest Method

1. Send a message to the bot from the chat you want to use.
2. In your terminal, run:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
```

3. Look for the `chat` object in the response.
4. Copy the `chat.id`.

Examples:

- private chat: `123456789`
- group: `-987654321`
- supergroup: `-1001234567890`

### Important

Do this before setting a webhook.

Once a webhook is active, `getUpdates` will stop returning updates until the webhook is removed.

If you already set a webhook and need `getUpdates` again temporarily:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{"drop_pending_updates":false}'
```

Save the allowed chat ID in your credential tracker.

---

## Step 4: Create the Deduplication Table in Supabase

Telegram retries webhook deliveries when your endpoint does not acknowledge them quickly enough. To avoid duplicate captures, create a tiny table that stores processed `update_id` values.

This repository includes the SQL in:

`supabase/sql/telegram_capture_events.sql`

Run it in the Supabase SQL editor:

```sql
create table if not exists public.telegram_capture_events (
  update_id bigint primary key,
  chat_id bigint not null,
  message_id bigint,
  processed_at timestamptz not null default now()
);
```

That is enough for deduplication in v1.

### Create the Chat Memory Tables

The assistant also keeps temporary Telegram memory in Supabase.

This repository includes the migration in:

`supabase/migrations/20260406193000_telegram_chat_memory.sql`

It creates:

- `telegram_chat_state`
- `telegram_chat_messages`
- `telegram_chat_summaries`

Run that migration too, or apply the SQL in the Supabase editor if you prefer.

---

## Step 5: Create the Edge Function

This repository includes a ready-to-use Edge Function at:

`supabase/functions/telegram-capture/index.ts`

If you are adding it to an existing Supabase project, create the function first:

```bash
supabase functions new telegram-capture
```

Then replace the generated file with the `index.ts` in this repository.

### What the Function Does

The function:

1. verifies the Telegram webhook secret
2. reads the incoming Telegram update
3. ignores unsupported or unauthorized messages
4. deduplicates by `update_id`
5. detects whether the incoming message is a save request or a retrieval request
6. calls the matching Open Brain MCP tool
7. replies in Telegram with either a confirmation or retrieved results

### Reliability Detail

The function claims an `update_id` before processing to avoid duplicate concurrent handling.

If the MCP call fails, the function releases that claim so Telegram can retry and the message is not lost permanently.

---

## Step 6: Set the Edge Function Secrets

You need seven secrets.

### Required Secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `OPENBRAIN_MCP_URL`
- `OPENBRAIN_MCP_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`

### Secret Meanings

- `TELEGRAM_BOT_TOKEN`
  The bot token from `@BotFather`
- `TELEGRAM_WEBHOOK_SECRET`
  A random secret string that Telegram sends back in the `X-Telegram-Bot-Api-Secret-Token` header
- `TELEGRAM_ALLOWED_CHAT_IDS`
  A comma-separated list of allowed chat IDs, for example `123456789,-1001234567890`
- `OPENBRAIN_MCP_URL`
  The base Open Brain MCP URL without the `?key=` query parameter
- `OPENBRAIN_MCP_KEY`
  Your Open Brain MCP key
- `OPENROUTER_API_KEY`
  Your OpenRouter API key used for conversational chat
- `OPENROUTER_MODEL`
  The OpenRouter model name, for example `openai/gpt-4.1-mini`

### Example `.env`

The repository includes a safe example file:

`/.env.example`

Its contents are:

```env
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
TELEGRAM_WEBHOOK_SECRET=replace-with-random-secret-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1001234567890
OPENBRAIN_MCP_URL=https://your-project.supabase.co/functions/v1/open-brain-mcp
OPENBRAIN_MCP_KEY=replace-with-your-openbrain-key
OPENROUTER_API_KEY=replace-with-your-openrouter-key
OPENROUTER_MODEL=google/gemini-3-flash-preview
```

### Set Secrets in Supabase

```bash
supabase secrets set TELEGRAM_BOT_TOKEN="your-bot-token"
supabase secrets set TELEGRAM_WEBHOOK_SECRET="replace-with-random-secret"
supabase secrets set TELEGRAM_ALLOWED_CHAT_IDS="123456789"
supabase secrets set OPENBRAIN_MCP_URL="https://your-project.supabase.co/functions/v1/open-brain-mcp"
supabase secrets set OPENBRAIN_MCP_KEY="your-openbrain-key"
supabase secrets set OPENROUTER_API_KEY="your-openrouter-key"
supabase secrets set OPENROUTER_MODEL="google/gemini-3-flash-preview"
```

### Generate a Good Webhook Secret

Telegram webhook secret tokens should only use letters, numbers, `_`, and `-`.

Example:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Telegram allows values from 1 to 256 characters.

### Notes

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically available inside Supabase Edge Functions
- never commit real secrets to GitHub
- never hardcode your Open Brain key in source code

---

## Step 7: Deploy the Function

Deploy with JWT verification disabled because Telegram is the caller, not an authenticated Supabase user.

```bash
supabase functions deploy telegram-capture --no-verify-jwt
```

After deployment, save the function URL. It will look like:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-capture
```

---

## Step 8: Register the Telegram Webhook

Now tell Telegram to deliver bot messages to your Edge Function.

Run:

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

You should get a success response like:

```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

### Check Webhook Status

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

If Telegram cannot reach your function, this endpoint usually tells you why.

---

## Step 9: Test It

### Simple Test

Send this to your bot:

```text
Need to add a Telegram capture integration to Open Brain and keep the implementation thin by reusing MCP capture_thought.
```

Expected behavior:

1. Telegram delivers the message to the webhook
2. The Edge Function verifies the secret and allowlisted chat
3. The function records the `update_id` in `telegram_capture_events`
4. The function calls your Open Brain MCP server
5. The bot replies to the same Telegram message with something like:

```text
Captured to Open Brain
Captured as idea - telegram, open brain
```

### Confirm It Worked

Use your Open Brain MCP tools to verify that the thought exists, or ask the bot directly.

For example:

- search for `telegram capture integration`
- list recent thoughts
- ask `what ideas do I have saved?`

---

## How the Thought Is Stored

The function sends the raw message text plus some capture context to Open Brain.

Example:

```text
Need to add a Telegram capture integration to Open Brain and keep the implementation thin by reusing MCP capture_thought.

[Source: Telegram | Chat: private:123456789 | From: @yourusername | Message ID: 42 | Sent At: 2026-04-06T18:22:00.000Z]
```

That makes the stored thought understandable later even when it is retrieved outside Telegram.

---

## Local Testing Without Telegram

You can test the webhook handler by posting a fake Telegram update directly to the deployed function.

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
      "text": "what ideas do I currently have saved?"
    }
  }'
```

If this works, the core integration logic is correct and any remaining problem is likely Telegram webhook setup.

---

## Troubleshooting

### `getUpdates` returns nothing

You probably already set a webhook. Telegram only allows one delivery method at a time.

Temporarily clear the webhook:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{"drop_pending_updates":false}'
```

### Telegram shows webhook errors

Check:

- the deployed Edge Function URL is correct
- the function is deployed with `--no-verify-jwt`
- the webhook secret matches exactly
- `getWebhookInfo` shows no recent Telegram delivery error

### Messages arrive but nothing is saved or returned

Check:

- the chat ID is present in `TELEGRAM_ALLOWED_CHAT_IDS`
- the message contains `text` or `caption`
- the Open Brain MCP URL and key are correct
- the Open Brain MCP server is reachable from the Edge Function

### Duplicate captures happen

Check:

- the `telegram_capture_events` table exists
- `update_id` is the primary key
- the latest function code is deployed

### Group messages do not show up

Check:

- the bot is actually in the group
- the group chat ID is allowlisted
- bot privacy mode is disabled if you want normal group messages

### The bot replies with an MCP failure

Check the Edge Function logs:

- Supabase Dashboard -> Edge Functions -> `telegram-capture` -> Logs

Most likely causes:

- wrong Open Brain MCP URL
- wrong Open Brain MCP key
- malformed MCP response
- temporary network failure

---

## Recommended Follow-Up Improvements

Once v1 is working, the best next upgrades are:

1. Add voice note transcription before capture
2. Add photo OCR before capture
3. Add richer natural-language routing beyond the current heuristic assistant
4. Add a true LLM response layer if you want open-ended chat instead of tool routing
5. Add better result formatting for long search and list responses
6. Add conversation memory or multi-step assistant workflows

---

## What You Built

You now have a Telegram inbox and lightweight assistant for your Open Brain.

That means you can capture ideas from your phone with very low friction and also query your saved thoughts without leaving Telegram.

This is still a clean architecture because Telegram only handles transport and routing, while Open Brain remains responsible for memory storage and retrieval.
