# UI - IT Helpdesk Agent trace viewer

A chat interface for the Day 04 agent that shows, for every turn, which tools
the model chose, what arguments it passed, what came back, and how long each
step took.

## The one thing that matters about this UI

It does not contain an agent loop. `ui/api/_agent.py` imports
`run_model_tool_loop` from `starter_v0/chat.py` and runs that. The CLI
(`python chat.py`), the evaluator, and this UI therefore make identical routing
decisions, which is what `LAB-GUIDE.md` section 9 asks for. If you change the
system prompt or the tool declarations, this UI picks the change up with no
edit here at all.

What it adds on top of the loop is measurement: how long each model call and
each tool call took, and how many tokens each model call actually billed. Those
numbers come from a clock and from the provider's own usage metadata. None of
them are estimated or invented.

## Running it locally

You need two processes, because `next dev` serves the pages but does not run
Python. One terminal each.

**Terminal 1 - the agent API.** Activate the lab's virtual environment first,
so the Google SDK and the tool code are importable:

```bash
cd starter_v0
. .venv/Scripts/activate      # Windows. On macOS or Linux: source .venv/bin/activate
cd ../ui
python scripts/local_api.py
```

It should print the lab package path, the model, and `listening on
http://127.0.0.1:8787`.

**Terminal 2 - the pages.**

```bash
cd ui
npm install
npm run dev
```

Open http://localhost:3000. In development `next.config.ts` forwards `/api/*`
to the Python server on port 8787. In production those same paths are real
serverless functions, so nothing is forwarded.

### If you have not set up the Python side yet

```bash
cd starter_v0
py -3 -m venv .venv
. .venv/Scripts/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

Then put your `GEMINI_API_KEY` in `starter_v0/.env`. That file is gitignored and
must never be committed. The UI reads it through the lab's own `env_loader`.

## Why there is a `.lab/` folder

On Vercel the project's root directory is `ui/`, so anything above it is not
uploaded and `starter_v0/` would be missing at runtime. `scripts/sync-lab.mjs`
copies it to `ui/.lab/` during the install step, which Vercel runs before it
bundles the functions, so the ordering is guaranteed rather than lucky.

`.lab/` is gitignored. The lab code has exactly one home: `starter_v0/`. The
copy never includes `.env`, `.venv`, `__pycache__`, or generated tickets.

Locally you will not normally have a `.lab/`, and it does not matter if you do:
the live `starter_v0/` checkout always takes precedence, so you are never
running a stale snapshot of the prompt or the tools.

## The API

**`GET /api/meta`** - the artifact version and hashes, read off the files on
disk. This is what the header shows, so it can never claim a version the
deployment is not actually running.

**`POST /api/chat`**

```jsonc
// request
{ "message": "Laptop LT-318 khong vao duoc VPN.", "history": [] }

// response (abridged)
{
  "status": "answered",          // or waiting_for_user, max_tool_rounds, provider_error
  "reply": "...",                // the human-readable answer, already unwrapped
  "tool_events": [ { "tool": "inspect_device", "args": {...}, "result": {...} } ],
  "spans": [ ... ],              // measured timings, drawn as the timeline
  "artifact": { "artifact_version": "v0+p233ec2ce+teb3e2243", ... }
}
```

`reply` exists because the baseline prompt tells the model to answer in a JSON
envelope (`intent`, `action`, `reply`, `evidence_ids`). The API unwraps that
when it sees it and falls back to the raw text when it does not, so whichever
direction the prompt owner takes the artifact, the chat bubble stays readable.

## Things that will bite you

**Rate limits.** The Gemini free tier limits requests per minute, and one turn
makes several calls in a row. The API retries with backoff and respects the
server's own retry hint, but it gives up after about 32 seconds rather than
exceed the request time budget. When that happens the turn comes back with
`status: "provider_error"` and a plain-language message. Send it again in a
moment; nothing is broken.

**Turns are slow.** Five to fifteen seconds is normal. Most of it is the model,
not the tools - the local tools answer in about a millisecond, which the
timeline makes obvious.

**A turn that fails partway still shows its trace.** If the second model call is
rate limited after the first tool already ran, you still see that tool call and
its result. The evidence of what happened is not thrown away just because the
turn did not finish.
