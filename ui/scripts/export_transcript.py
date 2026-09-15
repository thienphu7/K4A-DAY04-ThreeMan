"""Export a stored conversation as a lab transcript file.

The header's Transcript button downloads the session the browser is holding,
which is the right thing when you are sitting in front of it. Committing
evidence needs the other direction: read a conversation back out of the
database, by id, long after the tab was closed, and write it where the lab
keeps its transcripts.

The output shape is the one `ui/lib/transcript.ts` builds, field for field, so
a file written here and a file downloaded from the browser are the same
document and `starter_v0/transcripts/` stays readable as one set.

    python scripts/export_transcript.py --list
    python scripts/export_transcript.py <conversation-id> [--out DIR] [--name NAME]

`--out` defaults to `starter_v0/transcripts/`, which is where chat.py writes its
own transcripts - and which both .gitignore files exclude, because it is local
scratch. Evidence that is meant to be committed goes under `evidence/<member>/`
with the rest of the team's runs; pass --out for that.

Reads through api/_history.py, so it uses the same credentials and the same
PostgREST calls the running UI does, and needs no database client of its own.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

UI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(UI_ROOT / "api"))

# Every conversation title in this lab is Vietnamese and a Windows console
# still defaults to cp1252, which cannot encode it. Without this, --list dies
# on its first line of output.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import _agent  # noqa: E402,F401  loads .env for both layers before _history reads it
import _history  # noqa: E402

DEFAULT_OUT = UI_ROOT.parent / "starter_v0" / "transcripts"


def _turn(row: dict) -> dict:
    """One stored row in the field order lib/transcript.ts writes."""
    stamp = (row.get("created_at") or "")[:19]
    return {
        "turn_index": row.get("turn_index"),
        "started_at": stamp,
        "ended_at": stamp,
        "user": row.get("user_message"),
        "status": row.get("status"),
        "assistant_text": row.get("assistant_text"),
        "reply": row.get("reply"),
        "rounds": row.get("rounds") or [],
        "tool_events": row.get("tool_events") or [],
        "spans": row.get("spans") or [],
        "duration_ms": row.get("duration_ms"),
        "retries": row.get("retries") or 0,
        "error": row.get("error"),
    }


def build(conversation_id: str) -> dict:
    loaded = _history.load_conversation(conversation_id)
    if loaded is None:
        raise SystemExit(f"No conversation with id {conversation_id}")
    conversation, rows = loaded["conversation"], loaded["turns"]
    # Per turn rather than per conversation: the prompt can be edited between
    # turns, and the last turn is the one the reader is looking at.
    last = rows[-1] if rows else {}
    created = (conversation.get("created_at") or "")[:19]
    stamp = created.replace("-", "").replace(":", "")
    version = last.get("artifact_version", "") or ""
    label = version.split("+")[0] or "unknown"
    provider = last.get("provider") or conversation.get("provider") or "unknown"
    return {
        "transcript_id": f"{label}_{provider}_{stamp}",
        "source": "ui",
        "version": label,
        "artifact_version": version or "unknown",
        "prompt_hash": last.get("prompt_hash") or "",
        "tools_hash": last.get("tools_hash") or "",
        "provider": provider,
        "model": last.get("model") or conversation.get("model") or "unknown",
        "created_at": created,
        "updated_at": (conversation.get("updated_at") or "")[:19],
        "conversation_id": conversation.get("id"),
        "turns": [_turn(row) for row in rows],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("conversation_id", nargs="?")
    parser.add_argument("--list", action="store_true", help="Show stored conversations and exit.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--name", default=None, help="Filename stem. Defaults to the transcript id.")
    args = parser.parse_args()

    if not _history.configured():
        raise SystemExit("No database configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")

    if args.list:
        for row in _history.list_conversations(200):
            print(f"{row['id']}  {row.get('turn_count', 0):>2} turns  {row.get('title', '')[:60]}")
        return

    if not args.conversation_id:
        parser.error("Pass a conversation id, or --list to see them.")

    transcript = build(args.conversation_id)
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"{args.name or transcript['transcript_id']}.transcript.json"
    path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{path}  ({len(transcript['turns'])} turns)")


if __name__ == "__main__":
    main()
