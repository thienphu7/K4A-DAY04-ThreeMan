-- Conversation history for the IT Helpdesk Agent UI.
--
-- Access model: every read and write goes through the Python serverless
-- functions in ui/api/ using the service role key. Row level security is
-- enabled with NO policies, which denies the anon and publishable keys
-- entirely while the service role bypasses RLS by design. The browser never
-- talks to this database directly, so there is no key in the client bundle
-- that can read or forge a row.
--
-- Tables are prefixed `agent_` so this project can host other schemas later
-- without a name collision.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- conversations

create table if not exists public.agent_conversations (
    id           uuid primary key default gen_random_uuid(),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),

    -- First user message, trimmed. Lets the history list render without
    -- reading every turn of every conversation.
    title        text,

    -- Denormalised so the list view is a single query.
    turn_count   integer not null default 0,
    last_status  text,

    -- Which artifacts and model were in play when the conversation started.
    -- Kept per conversation for the list, and again per turn because the
    -- prompt can be edited between turns.
    artifact_version text,
    provider         text,
    model            text
);

comment on table public.agent_conversations is
    'One chat session in the helpdesk agent UI. Written only by the server.';

-- --------------------------------------------------------------------- turns

create table if not exists public.agent_turns (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null
        references public.agent_conversations (id) on delete cascade,
    turn_index      integer not null,
    created_at      timestamptz not null default now(),

    user_message    text not null,

    -- Mirrors the loop's own status values plus transport_error, which is the
    -- UI's own outcome for a request that never reached the provider.
    status          text not null,
    reply           text,
    assistant_text  text,
    error           text,

    -- The audit trail. Stored as jsonb rather than flattened because a grader
    -- needs the tool arguments and raw results exactly as they were produced,
    -- and because the loop's shape belongs to starter_v0, not to this schema.
    structured_output jsonb,
    rounds            jsonb not null default '[]'::jsonb,
    tool_events       jsonb not null default '[]'::jsonb,
    spans             jsonb not null default '[]'::jsonb,

    duration_ms     integer,
    retries         integer not null default 0,

    -- Recorded per turn, not just per conversation: the prompt and tool
    -- declarations can be edited between turns, and evidence is only evidence
    -- if it names the artifacts that produced it.
    artifact_version text,
    prompt_hash      text,
    tools_hash       text,
    provider         text,
    model            text,

    constraint agent_turns_status_check check (
        status in (
            'answered',
            'waiting_for_user',
            'max_tool_rounds',
            'provider_error',
            'transport_error'
        )
    ),
    constraint agent_turns_unique_index unique (conversation_id, turn_index)
);

comment on table public.agent_turns is
    'One user turn and everything the agent did in response. Written only by the server.';

-- ------------------------------------------------------------------- indexes

-- The history list: newest conversations first.
create index if not exists agent_conversations_updated_at_idx
    on public.agent_conversations (updated_at desc);

-- Loading one conversation: its turns in order.
create index if not exists agent_turns_conversation_idx
    on public.agent_turns (conversation_id, turn_index);

-- ------------------------------------------------------- keep updated_at true

create or replace function public.agent_touch_conversation()
returns trigger
language plpgsql
security definer
-- Pinned search_path: a security definer function that resolves names through
-- the caller's search_path is a privilege escalation route.
set search_path = public, pg_temp
as $$
begin
    update public.agent_conversations
       set updated_at  = now(),
           turn_count  = (
               select count(*) from public.agent_turns
                where conversation_id = new.conversation_id
           ),
           last_status = new.status
     where id = new.conversation_id;
    return new;
end;
$$;

drop trigger if exists agent_turns_touch_conversation on public.agent_turns;
create trigger agent_turns_touch_conversation
    after insert on public.agent_turns
    for each row execute function public.agent_touch_conversation();

-- ----------------------------------------------------------------------- rls

-- Enabled with no policies on purpose. With RLS on and no policy present,
-- PostgREST requests made with the anon or publishable key match zero rows for
-- select and are rejected for insert. The service role bypasses RLS, so the
-- server keeps full access. If browser access is ever wanted, it needs real
-- auth and an explicit policy; it must not be granted by turning RLS off.
alter table public.agent_conversations enable row level security;
alter table public.agent_turns          enable row level security;

revoke all on public.agent_conversations from anon, authenticated;
revoke all on public.agent_turns          from anon, authenticated;
