"""Conversation history, stored in Supabase.

Talks to PostgREST over plain HTTP with `requests`, which the functions already
depend on. A dedicated client library would add bundle weight and cold start
time for four straightforward calls.

Two rules shape everything here:

  * **History is never allowed to break a chat turn.** Every call is wrapped and
    every failure is swallowed into a log line. A database outage, a bad key or
    a missing table degrades the product to "no history" rather than "no agent".
  * **The service role key never leaves the server.** It is read from the
    environment, sent only to the Supabase REST endpoint, and never returned in
    a response or written to a log.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

import requests

CONVERSATIONS = "agent_conversations"
TURNS = "agent_turns"


# Read on each call rather than captured at import. _agent is what loads the
# local .env files, and _routes imports this module first, so module-level
# constants would be read before those files had been applied and history would
# silently switch itself off during local development.
def _base_url() -> str:
    return (os.getenv("SUPABASE_URL") or "").rstrip("/")


def _service_key() -> str:
    return os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""

# Separate connect and read budgets. 6s for the whole exchange was too tight: a
# cold function reaching Supabase across regions timed out and the read was
# reported as an empty list. Connecting stays short because a genuinely
# unreachable host should fail fast; reading gets room for a cold start.
TIMEOUT_S = (5, 20)
# Writes are best-effort and sit inside a turn the user is waiting on, so they
# get a tighter budget than reads, which the user asked for directly.
WRITE_TIMEOUT_S = (5, 10)
TITLE_MAX = 120


class HistoryUnavailable(RuntimeError):
    """The database could not be reached or refused the request.

    Exists so a read can tell "there are no conversations" apart from "the
    lookup failed". Collapsing those two into an empty list is how the UI ended
    up stating there was no history while the rows were sitting in the table.
    """


def configured() -> bool:
    """True when both halves of the credential are present."""
    return bool(_base_url() and _service_key())


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    key = _service_key()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def _log(message: str) -> None:
    # stderr, and never with the key or a row's contents in it.
    print(f"[history] {message}", file=sys.stderr)


def _request(method: str, path: str, *, attempts: int = 3, **kwargs: Any) -> Any:
    """Call PostgREST. Raises HistoryUnavailable rather than returning a value
    that a caller could mistake for "no rows"."""
    if not configured():
        raise HistoryUnavailable("No database is configured.")

    timeout = kwargs.pop("timeout", TIMEOUT_S)
    extra_headers = kwargs.pop("extra_headers", None)
    endpoint = path.split("?")[0]
    last: str = "unknown error"

    for attempt in range(1, attempts + 1):
        try:
            response = requests.request(
                method,
                f"{_base_url()}/rest/v1/{path}",
                headers=_headers(extra_headers),
                timeout=timeout,
                **kwargs,
            )
        except requests.RequestException as exc:
            last = type(exc).__name__
            _log(f"{method} {endpoint} failed: {last} (attempt {attempt}/{attempts})")
            if attempt < attempts:
                time.sleep(1.5 * attempt)
            continue

        if response.status_code < 400:
            if not response.content:
                return []
            try:
                return response.json()
            except ValueError:
                return []

        # The body can name a missing table or a policy problem, which is worth
        # seeing; it never contains the key.
        detail = response.text[:200]
        last = f"HTTP {response.status_code}: {detail}"
        _log(f"{method} {endpoint} -> {last}")

        # 5xx is a free-tier project waking from idle, and PGRST205 is PostgREST
        # not having reloaded its schema cache yet after a migration. Both clear
        # on their own given a moment, so they are worth another try.
        retriable = response.status_code >= 500 or "PGRST205" in detail
        if not retriable:
            break
        # Retrying instantly just asks a database that is still starting the
        # same question again, so back off between attempts.
        if attempt < attempts:
            time.sleep(1.5 * attempt)

    raise HistoryUnavailable(last)


def _title_from(message: str) -> str:
    single_line = " ".join(message.split())
    return single_line[:TITLE_MAX] if single_line else "Untitled conversation"


def start_conversation(first_message: str, meta: dict[str, Any]) -> str | None:
    """Create a conversation row and return its id, or None if unavailable.

    Writes stay best-effort: they sit inside a turn the user is waiting on, so a
    database problem degrades to "not recorded" rather than failing the turn.
    """
    try:
        rows = _request(
            "POST",
            CONVERSATIONS,
            timeout=WRITE_TIMEOUT_S,
            json={
                "title": _title_from(first_message),
                "artifact_version": meta.get("artifact_version"),
                "provider": meta.get("provider"),
                "model": meta.get("model"),
            },
            extra_headers={"Prefer": "return=representation"},
        )
    except HistoryUnavailable:
        return None
    if isinstance(rows, list) and rows:
        return rows[0].get("id")
    return None


def record_turn(conversation_id: str, turn_index: int, message: str, result: dict[str, Any]) -> bool:
    """Append one turn. Returns whether it was stored; never raises."""
    artifact = result.get("artifact") or {}
    payload = {
        "conversation_id": conversation_id,
        "turn_index": turn_index,
        "user_message": message,
        "status": result.get("status"),
        "reply": result.get("reply"),
        "assistant_text": result.get("assistant_text"),
        "error": result.get("error"),
        "structured_output": result.get("structured_output"),
        "rounds": result.get("rounds") or [],
        "tool_events": result.get("tool_events") or [],
        "spans": result.get("spans") or [],
        "duration_ms": result.get("duration_ms"),
        "retries": result.get("retries") or 0,
        "artifact_version": artifact.get("artifact_version"),
        "prompt_hash": artifact.get("prompt_hash"),
        "tools_hash": artifact.get("tools_hash"),
        "provider": result.get("provider"),
        "model": result.get("model"),
    }
    try:
        _request(
            "POST",
            TURNS,
            timeout=WRITE_TIMEOUT_S,
            json=payload,
            extra_headers={"Prefer": "return=minimal"},
        )
    except HistoryUnavailable:
        return False
    return True


def list_conversations(limit: int = 50) -> list[dict[str, Any]]:
    """Newest first, without their turns: this feeds the history list.

    Raises HistoryUnavailable when the lookup fails, so the caller can say the
    list could not be loaded instead of showing an empty one.
    """
    limit = max(1, min(limit, 200))
    rows = _request(
        "GET",
        f"{CONVERSATIONS}?select=id,title,created_at,updated_at,turn_count,last_status,model"
        f"&order=updated_at.desc&limit={limit}",
    )
    return rows if isinstance(rows, list) else []


def load_conversation(conversation_id: str) -> dict[str, Any] | None:
    """One conversation with every turn, in order. None means no such row."""
    conversations = _request(
        "GET",
        f"{CONVERSATIONS}?id=eq.{conversation_id}&select=*&limit=1",
    )
    if not isinstance(conversations, list) or not conversations:
        return None
    turns = _request(
        "GET",
        f"{TURNS}?conversation_id=eq.{conversation_id}&select=*&order=turn_index.asc",
    )
    return {
        "conversation": conversations[0],
        "turns": turns if isinstance(turns, list) else [],
    }


def delete_conversation(conversation_id: str) -> None:
    """Remove a conversation. Its turns go with it via on delete cascade."""
    _request("DELETE", f"{CONVERSATIONS}?id=eq.{conversation_id}")
