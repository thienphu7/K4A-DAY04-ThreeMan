# Conversation history database

The UI saves every turn so a conversation can be reopened later and used as lab
evidence. This folder holds the schema that stores it.

## How access works, and why it is shaped this way

**Nothing in the browser talks to this database.** Every read and write goes
through the Python serverless functions in `ui/api/`, which authenticate with
the service role key.

That is a deliberate departure from Supabase's standard Next.js quickstart. The
quickstart puts a publishable key in the browser and relies on row level
security plus Supabase Auth to decide who may see what. This app has no user
accounts, and its turns are produced inside a Python function rather than a
Next.js server component, so the browser path would add a second place to reach
the data and nothing to authorise it with. Writing from the one place that
already owns the turn is both simpler and harder to abuse.

The schema therefore enables row level security with **no policies at all**:

| Key | What it can do |
|---|---|
| publishable / anon (safe to ship to a browser) | nothing: RLS with no policy matches zero rows and rejects writes |
| service role (server only, never in the client bundle) | full access, because the service role bypasses RLS |

If browser access is ever wanted, it needs real authentication and an explicit
policy. It must never be granted by turning RLS off.

## Applying the schema

The migration is applied with the Supabase CLI, never by pasting SQL into the
dashboard's editor: a migration file is reviewable, repeatable, and leaves the
next person a record of what changed.

```bash
npx supabase login                       # one time, opens a browser
npx supabase link --project-ref viqbdqhdgzfaauhuekar
npx supabase db push
```

`db push` is additive here. The migration creates two tables, two indexes, one
trigger and the RLS settings, and drops nothing.

To check what would run before running it:

```bash
npx supabase db diff --linked
```

## What is stored

`agent_conversations` is one chat session. It carries a title taken from the
first message and a denormalised `turn_count` and `last_status`, so the history
list is a single query rather than a query per row.

`agent_turns` is one user turn and everything the agent did in response: the
reply, the rounds, every tool call with its arguments and raw result, and the
measured spans. Those are stored as `jsonb` rather than flattened into columns,
because a grader needs them exactly as produced, and because their shape belongs
to `starter_v0/chat.py` rather than to this schema.

Both tables record the artifact version and the prompt and tools hashes. The
turn records them **again**, per turn, because the prompt can be edited between
two turns of the same conversation, and a result is only evidence if it names
the artifacts that produced it.

## Environment variables

Server side only. Never prefix these with `NEXT_PUBLIC_`, which would publish
them in the browser bundle.

| Name | Where |
|---|---|
| `SUPABASE_URL` | `ui/.env.local` locally, Vercel project settings in production |
| `SUPABASE_SERVICE_ROLE_KEY` | same, and never committed |

When they are absent the UI still runs; it simply does not record history. That
keeps a missing key from taking the whole app down, and it means a teammate can
work on the UI without needing database credentials.
