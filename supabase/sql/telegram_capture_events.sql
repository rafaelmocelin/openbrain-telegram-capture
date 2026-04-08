create table if not exists public.telegram_capture_events (
  update_id bigint primary key,
  chat_id bigint not null,
  message_id bigint,
  processed_at timestamptz not null default now()
);
