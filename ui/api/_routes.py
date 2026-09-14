"""Request handling shared by the Vercel functions and the local dev server.

Both entry points call these, so validation and response shape cannot drift
between `npm run dev` on a teammate's laptop and the deployed function.
"""

from __future__ import annotations

from typing import Any

try:
    import _history as history
    from _agent import DEFAULT_MODEL, DEFAULT_PROVIDER, LAB_ROOT, artifact_version, run_turn
except ImportError:  # imported as a package (local dev server)
    from api import _history as history  # type: ignore
    from api._agent import (  # type: ignore
        DEFAULT_MODEL,
        DEFAULT_PROVIDER,
        LAB_ROOT,
        artifact_version,
        run_turn,
    )

MAX_BODY_BYTES = 64 * 1024

# Accepting only well-formed ids keeps a malformed value out of the PostgREST
# filter string rather than relying on the database to reject it.
_UUID_LENGTH = 36
_UUID_CHARS = set("0123456789abcdefABCDEF-")


def _valid_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == _UUID_LENGTH
        and set(value) <= _UUID_CHARS
        and value.count("-") == 4
    )


def chat_response(payload: Any) -> tuple[int, dict[str, Any]]:
    if not isinstance(payload, dict):
        return 400, {"error": "invalid_payload", "message": "Expected a JSON object."}

    message = (payload.get("message") or "").strip()
    if not message:
        return 400, {"error": "missing_message", "message": "Field 'message' is required."}

    # Only well-formed turns are carried forward; anything else is dropped rather
    # than handed to the provider as a malformed message.
    chat_history = [
        {"role": item["role"], "content": item["content"]}
        for item in (payload.get("history") or [])
        if isinstance(item, dict)
        and item.get("role") in ("user", "assistant")
        and isinstance(item.get("content"), str)
    ]

    try:
        result = run_turn(
            message,
            chat_history,
            model=payload.get("model") or None,
            provider_name=payload.get("provider") or None,
        )
    except Exception as exc:  # noqa: BLE001 - rendered by the UI as a failed turn
        return 500, {"error": type(exc).__name__, "message": str(exc)}

    result["conversation_id"] = _persist(payload, message, result)
    return 200, result


def _persist(payload: dict[str, Any], message: str, result: dict[str, Any]) -> str | None:
    """Store the turn. Never raises: history must not be able to break a chat.

    A turn is worth keeping even when the run failed - a rate-limited turn is
    exactly the kind of evidence someone comes back to look at - so this records
    every outcome rather than only the successful ones.
    """
    if not history.configured():
        return None

    incoming = payload.get("conversation_id")
    conversation_id = incoming if _valid_id(incoming) else None
    # turn_index is supplied by the caller because the client owns the ordering
    # it is rendering; it is coerced here so a bad value cannot reach the insert.
    raw_index = payload.get("turn_index")
    turn_index = raw_index if isinstance(raw_index, int) and raw_index > 0 else 1

    try:
        if conversation_id is None:
            conversation_id = history.start_conversation(
                message,
                {
                    "artifact_version": (result.get("artifact") or {}).get("artifact_version"),
                    "provider": result.get("provider"),
                    "model": result.get("model"),
                },
            )
            turn_index = 1
        if conversation_id:
            history.record_turn(conversation_id, turn_index, message, result)
    except Exception:  # noqa: BLE001 - already logged inside the history module
        return conversation_id
    return conversation_id


# A failed lookup must never be reported as "no conversations". Saying the list
# is empty when it could not be read is how the UI ended up contradicting a
# database that had the rows in it.
_UNAVAILABLE = "History is temporarily unavailable. The database did not answer."


def history_list_response(limit: int = 50) -> tuple[int, dict[str, Any]]:
    if not history.configured():
        return 200, {"enabled": False, "conversations": []}
    try:
        return 200, {"enabled": True, "conversations": history.list_conversations(limit)}
    except history.HistoryUnavailable:
        return 503, {"error": "history_unavailable", "message": _UNAVAILABLE}


def history_get_response(conversation_id: Any) -> tuple[int, dict[str, Any]]:
    if not history.configured():
        return 404, {"error": "history_disabled", "message": "History is not configured."}
    if not _valid_id(conversation_id):
        return 400, {"error": "invalid_id", "message": "Expected a conversation UUID."}
    try:
        loaded = history.load_conversation(conversation_id)
    except history.HistoryUnavailable:
        return 503, {"error": "history_unavailable", "message": _UNAVAILABLE}
    if loaded is None:
        return 404, {"error": "not_found", "message": "No such conversation."}
    return 200, loaded


def history_delete_response(conversation_id: Any) -> tuple[int, dict[str, Any]]:
    if not history.configured():
        return 404, {"error": "history_disabled", "message": "History is not configured."}
    if not _valid_id(conversation_id):
        return 400, {"error": "invalid_id", "message": "Expected a conversation UUID."}
    try:
        history.delete_conversation(conversation_id)
    except history.HistoryUnavailable:
        return 503, {"error": "history_unavailable", "message": _UNAVAILABLE}
    return 200, {"deleted": conversation_id}


def meta_response() -> tuple[int, dict[str, Any]]:
    try:
        return 200, {
            "ok": True,
            "artifact": artifact_version(),
            "model": DEFAULT_MODEL,
            "provider": DEFAULT_PROVIDER,
            "lab_root": str(LAB_ROOT),
            # Lets the UI hide the history panel entirely rather than show an
            # empty one when the database is not configured.
            "history_enabled": history.configured(),
        }
    except Exception as exc:  # noqa: BLE001
        return 500, {"ok": False, "error": type(exc).__name__, "message": str(exc)}
