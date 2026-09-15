"""Shared agent logic for the Day 04 helpdesk UI.

The point of this module is that it does NOT implement an agent loop. It imports
`run_model_tool_loop` from the lab's own `chat.py` and instruments it from the
outside, so the UI, the CLI and the eval all exercise identical routing
behaviour. LAB-GUIDE.md section 9 asks for exactly this.

Two things are wrapped rather than edited, because `chat.py` and the tools are
graded artifacts that other teammates own:

  * the provider - wrapped for retry/backoff and token+latency capture. The loop
    already takes `provider` as an argument, so this needs no patching.
  * `create_ticket`'s output directory - repointed to a writable path, because a
    serverless filesystem is read-only outside /tmp.
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# --- locate the lab package -------------------------------------------------
# The live checkout wins wherever it exists, so a teammate editing
# starter_v0/artifacts/ sees their change immediately. `.lab/` is the copy made
# by scripts/sync-lab.mjs at install time and is only reachable on Vercel, where
# the project root is ui/ and starter_v0 was never uploaded. Checking `.lab`
# first would silently serve a stale snapshot during local development.
_UI_ROOT = Path(__file__).resolve().parents[1]
_CANDIDATES = [_UI_ROOT.parent / "starter_v0", _UI_ROOT / ".lab"]
LAB_ROOT = next((p for p in _CANDIDATES if (p / "chat.py").exists()), None)
if LAB_ROOT is None:
    raise RuntimeError(
        "Cannot locate the lab package. Looked for chat.py in: "
        + ", ".join(str(p) for p in _CANDIDATES)
        + ". Run `node scripts/sync-lab.mjs` from ui/."
    )
sys.path.insert(0, str(LAB_ROOT))

# Load local secrets only when a real checkout is present. On Vercel every key
# arrives as a project environment variable and no .env is ever bundled.
#
# Two files, because they belong to different layers: the lab's own provider
# keys live with the lab, and this UI's database credentials live with the UI.
# Neither is committed, and process environment always wins so a Vercel value is
# never overwritten by a stray file.
from env_loader import load_dotenv  # type: ignore  # noqa: E402

for _env_file in (_UI_ROOT.parent / "starter_v0" / ".env", _UI_ROOT / ".env.local"):
    if _env_file.exists():
        load_dotenv(_env_file, override=False)

import chat  # noqa: E402  the lab's own loop
from providers import make_provider  # noqa: E402
from tools import load_tool_declarations, to_openai_tools  # noqa: E402
from versioning import artifact_version_dict, build_artifact_version  # noqa: E402

# --- serverless filesystem shim ---------------------------------------------
# tools/create_ticket writes a JSON file. Everything outside /tmp is read-only on
# Vercel, so point the tool at a writable directory without touching the graded
# implementation. Locally this leaves the repo's own tickets/ folder alone.
if os.getenv("VERCEL"):
    # Taken from sys.modules rather than imported by dotted path: `from tools
    # import ...` above has already loaded this module, and inside the Vercel
    # bundle the dotted form resolves `create_ticket` as a top-level namespace
    # package and raises. Looking it up cannot fail, and if it were ever absent
    # the tool would simply report a write error instead of breaking startup.
    _ticket_tool = sys.modules.get("tools.create_ticket.tool")
    if _ticket_tool is not None:
        _ticket_tool.TICKET_DIR = Path("/tmp/tickets")

ARTIFACTS = LAB_ROOT / "artifacts"
DEFAULT_MODEL = os.getenv("LAB_MODEL", "gemini-3.1-flash-lite")
DEFAULT_PROVIDER = os.getenv("LAB_PROVIDER", "gemini")
# The label the UI reports alongside the hashes. artifacts/ belongs to other
# team members, so this tracks whatever they have landed rather than leading it:
# bump it when they add a version_log.csv row, or set LAB_VERSION to override.
# The hashes beside it are computed from the files themselves, so a stale label
# here shows up as a mismatch rather than passing silently.
#
# v3 because version_log.csv now ends on the selected v3 row
# (v3+p948dcfae982e+t365b679704cd), which is what artifacts/ currently hashes to.
VERSION_LABEL = os.getenv("LAB_VERSION", "v3")
MAX_TOOL_ROUNDS = int(os.getenv("LAB_MAX_TOOL_ROUNDS", "4"))
HISTORY_WINDOW = int(os.getenv("LAB_HISTORY_WINDOW", "5"))

# A Vercel Hobby function is killed at 60s. Retrying a rate limit past that
# budget cannot produce an answer - it only converts a useful error into a
# timeout with no trace at all. Stop retrying in time to return what we have.
RETRY_BUDGET_S = float(os.getenv("LAB_RETRY_BUDGET_S", "32"))

# Tools that change state or pause the run read differently in a trace than
# read-only lookups, so they get their own span kind.
_IO_TOOLS = {"clarify", "create_ticket", "format_incident_report"}


@dataclass
class ModelCall:
    """One provider round trip, measured from the outside."""

    start_ms: int
    end_ms: int
    tokens: int | None = None
    attempts: int = 1
    error: str | None = None


@dataclass
class Instrumented:
    """Wraps a provider: retries transient failures, records timing and tokens.

    `run_model_tool_loop` accepts the provider as a parameter, so wrapping it is
    enough to observe every model call without editing the loop.
    """

    inner: Any
    clock_zero: float
    calls: list[ModelCall] = field(default_factory=list)
    max_attempts: int = 6

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)

    def _ms(self) -> int:
        return int((time.perf_counter() - self.clock_zero) * 1000)

    def complete(self, *args: Any, **kwargs: Any) -> Any:
        start = self._ms()
        deadline = time.perf_counter() + RETRY_BUDGET_S
        delay = 2.0
        for attempt in range(1, self.max_attempts + 1):
            try:
                response = self.inner.complete(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001 - classified immediately below
                # Google tells us how long to wait; trust it over our own guess.
                wait = _retry_after(exc) or (delay + random.random())
                out_of_budget = time.perf_counter() + wait > deadline
                if not _is_transient(exc) or attempt == self.max_attempts or out_of_budget:
                    self.calls.append(
                        ModelCall(start, self._ms(), attempts=attempt, error=_friendly_error(exc))
                    )
                    raise
                # Free-tier Gemini limits requests per minute and a tool loop
                # fires several in a row. Back off rather than failing the turn.
                time.sleep(wait)
                delay *= 2
                continue
            self.calls.append(ModelCall(start, self._ms(), tokens=_usage_tokens(response), attempts=attempt))
            return response
        raise RuntimeError("provider exhausted retries")


def _is_transient(exc: Exception) -> bool:
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code in (429, 500, 502, 503, 504):
        return True
    text = str(exc).upper()
    return any(flag in text for flag in ("RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL"))


_RETRY_DELAY = re.compile(r"['\"]retryDelay['\"]\s*:\s*['\"](\d+(?:\.\d+)?)s['\"]")


def _retry_after(exc: Exception) -> float | None:
    """The server's own RetryInfo, in seconds, when it sent one."""
    match = _RETRY_DELAY.search(str(exc))
    if not match:
        return None
    # Clamp: a very large server hint is not worth holding a request open for.
    return min(float(match.group(1)) + 0.5, RETRY_BUDGET_S)


def _friendly_error(exc: Exception) -> str:
    """Plain-language cause, so the UI is not just showing a stack trace."""
    raw = f"{type(exc).__name__}: {exc}"
    if _is_transient(exc) and ("429" in raw or "RESOURCE_EXHAUSTED" in raw.upper()):
        return (
            "Rate limited by the Gemini free tier (requests per minute). "
            "The run stopped rather than exceed the request time budget. Send the message again in a moment."
        )
    return raw[:400]


def _usage_tokens(response: Any) -> int | None:
    """Real token count off the provider response, or None. Never estimated."""
    usage = getattr(getattr(response, "raw", None), "usage_metadata", None)
    total = getattr(usage, "total_token_count", None)
    return int(total) if isinstance(total, int) else None


def _summarize(result: Any) -> str:
    """One short line describing what a tool returned, for the trace result column."""
    if not isinstance(result, dict):
        return str(result)[:60]
    if result.get("error"):
        return str(result["error"])[:60]
    if result.get("awaiting_user"):
        return "awaiting user"
    for key in ("ticket_id", "status", "asset_id", "employee_id", "service"):
        value = result.get(key)
        if value:
            return f"{key}={value}"[:60]
    for key in ("results", "articles", "matches"):
        value = result.get(key)
        if isinstance(value, list):
            return f"{len(value)} result{'s' if len(value) != 1 else ''}"
    fields = [key for key in result if key != "tool"]
    return f"{len(fields)} field{'s' if len(fields) != 1 else ''}"


def _kind(tool_name: str) -> str:
    return "io" if tool_name in _IO_TOOLS else "tool"


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def extract_reply(text: str | None) -> tuple[str, dict[str, Any] | None]:
    """Pull the human-readable answer out of the model's text.

    The baseline system prompt orders the model to emit JSON with
    intent/action/reply/evidence_ids. That is deliberate lab design, not a
    defect, so the UI renders `reply` when it sees that shape and falls back to
    raw text otherwise. This keeps working whichever way the prompt owner takes
    the artifact.
    """
    if not text:
        return "", None
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", candidate).strip()
    match = _JSON_BLOCK.search(candidate)
    if not match:
        return text, None
    try:
        # strict=False allows raw newlines and tabs inside the string values.
        # The model writes multi-step instructions into `reply` and sometimes
        # breaks the lines literally instead of escaping them, which strict JSON
        # rejects as a control character. Refusing to parse there put the whole
        # envelope on screen as raw JSON in place of the answer.
        parsed = json.loads(match.group(0), strict=False)
    except (json.JSONDecodeError, ValueError):
        return text, None
    if not isinstance(parsed, dict):
        return text, None
    reply = parsed.get("reply")
    return (reply if isinstance(reply, str) and reply.strip() else text), parsed


def artifact_version() -> dict[str, str]:
    return artifact_version_dict(
        build_artifact_version(VERSION_LABEL, ARTIFACTS / "system_prompt.md", ARTIFACTS / "tools.yaml")
    )


def run_turn(
    user_text: str,
    history: list[dict[str, str]] | None = None,
    *,
    model: str | None = None,
    provider_name: str | None = None,
) -> dict[str, Any]:
    """Run one user turn through the lab's loop and return a UI-ready trace."""
    history = history or []
    provider_name = provider_name or DEFAULT_PROVIDER
    model = model or DEFAULT_MODEL

    system_prompt = (ARTIFACTS / "system_prompt.md").read_text(encoding="utf-8")
    declarations = to_openai_tools(load_tool_declarations(ARTIFACTS / "tools.yaml"))

    clock_zero = time.perf_counter()
    provider = Instrumented(make_provider(provider_name), clock_zero)

    # Time each tool by wrapping the module-level function the loop calls.
    # Restored in `finally` so a failed turn cannot leave the wrapper installed.
    original_execute = chat.execute_tool_call
    tool_spans: list[dict[str, Any]] = []

    def timed_execute(call: Any) -> dict[str, Any]:
        start = int((time.perf_counter() - clock_zero) * 1000)
        event = original_execute(call)
        end = int((time.perf_counter() - clock_zero) * 1000)
        result = event.get("result")
        tool_spans.append(
            {
                "name": call.name,
                "start": start,
                "end": end,
                "status": "error" if isinstance(result, dict) and result.get("error") else "ok",
                "detail": _summarize(result),
                # Kept so a turn that dies mid-loop can still show what ran.
                "event": event,
            }
        )
        return event

    messages = [
        {"role": "system", "content": system_prompt},
        *chat.trim_history(history, HISTORY_WINDOW),
        {"role": "user", "content": user_text},
    ]

    chat.execute_tool_call = timed_execute
    try:
        result = chat.run_model_tool_loop(
            provider=provider,
            messages=messages,
            tools=declarations,
            model=model,
            max_tool_rounds=MAX_TOOL_ROUNDS,
        )
        error: str | None = None
    except Exception as exc:  # surfaced to the UI as a failed turn, not a 500
        # The loop keeps its progress in local variables, so a raise loses every
        # round that already succeeded. The instrumentation outlives the
        # exception, so rebuild the rounds from it: a turn that died after two
        # good tool calls should still show those two tool calls.
        result = {
            "status": "provider_error",
            "assistant_text": "",
            "rounds": _reconstruct_rounds(provider.calls, tool_spans),
            "tool_events": [span["event"] for span in tool_spans],
        }
        error = _friendly_error(exc)
    finally:
        chat.execute_tool_call = original_execute

    reply, structured = extract_reply(result.get("assistant_text"))
    spans = _build_spans(result, provider.calls, tool_spans)

    return {
        "status": result["status"],
        "error": error,
        "reply": reply,
        "assistant_text": result.get("assistant_text") or "",
        "structured_output": structured,
        "rounds": result.get("rounds", []),
        "tool_events": result.get("tool_events", []),
        "spans": spans,
        "duration_ms": max((span["end"] for span in spans), default=0),
        "model": model,
        "provider": provider_name,
        "artifact": artifact_version(),
        "retries": sum(call.attempts - 1 for call in provider.calls),
    }


def _reconstruct_rounds(
    model_calls: list[ModelCall],
    tool_spans: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rebuild round records from timings after the loop raised.

    Tools always run after the model call that requested them and before the
    next one, so the recorded timestamps are enough to reassign them. Used only
    on the failure path; a successful turn reports the loop's own rounds.
    """
    rounds: list[dict[str, Any]] = []
    for index, call in enumerate(model_calls):
        next_start = model_calls[index + 1].start_ms if index + 1 < len(model_calls) else float("inf")
        owned = [span for span in tool_spans if call.end_ms <= span["start"] < next_start]
        rounds.append(
            {
                "round": index + 1,
                "assistant_text": None,
                "tool_calls": [
                    {"name": span["name"], "args": span.get("event", {}).get("args", {})} for span in owned
                ],
                "tool_results": [],
            }
        )
    return rounds


def _build_spans(
    result: dict[str, Any],
    model_calls: list[ModelCall],
    tool_spans: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Turn measured timings into AgentTrace spans, one parent per tool round.

    Every number here came from a clock or from the provider's usage metadata.
    Nothing is synthesised; a round with no measurement simply does not appear.
    """
    spans: list[dict[str, Any]] = []
    cursor = 0  # tool spans are consumed in call order, matching the loop
    attempts_seen: dict[str, int] = {}

    for index, round_record in enumerate(result.get("rounds", [])):
        model_call = model_calls[index] if index < len(model_calls) else None
        calls = round_record.get("tool_calls", []) or []
        consumed = tool_spans[cursor : cursor + len(calls)]
        cursor += len(consumed)

        round_start = model_call.start_ms if model_call else (consumed[0]["start"] if consumed else 0)
        round_end = max([model_call.end_ms if model_call else 0] + [span["end"] for span in consumed])
        parent_id = f"round-{index + 1}"
        spans.append(
            {
                "id": parent_id,
                "label": f"round {index + 1}",
                "kind": "agent",
                "start": round_start,
                "end": round_end,
                "status": "ok",
                "detail": f"{len(calls)} call{'s' if len(calls) != 1 else ''}",
            }
        )

        if model_call:
            spans.append(
                {
                    "id": f"{parent_id}-model",
                    "parentId": parent_id,
                    "label": "model.complete",
                    "kind": "model",
                    "start": model_call.start_ms,
                    "end": model_call.end_ms,
                    "status": "error" if model_call.error else "ok",
                    "detail": model_call.error or f"{len(calls)} tool call{'s' if len(calls) != 1 else ''}",
                    **({"tokens": model_call.tokens} if model_call.tokens else {}),
                    **({"attempt": model_call.attempts} if model_call.attempts > 1 else {}),
                }
            )

        for position, span in enumerate(consumed):
            name = span["name"]
            attempts_seen[name] = attempts_seen.get(name, 0) + 1
            spans.append(
                {
                    "id": f"{parent_id}-tool-{position}",
                    "parentId": parent_id,
                    "label": name,
                    "kind": _kind(name),
                    "start": span["start"],
                    # A local mock tool can finish inside the same millisecond.
                    # Give it a 1ms floor so the bar is visible at all.
                    "end": max(span["end"], span["start"] + 1),
                    "status": span["status"],
                    "detail": span["detail"],
                    **({"attempt": attempts_seen[name]} if attempts_seen[name] > 1 else {}),
                }
            )

    return spans
