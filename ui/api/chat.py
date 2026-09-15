"""POST /api/chat - run one user turn through the lab's agent loop.

Request:  {"message": str, "history": [{"role": "user"|"assistant", "content": str}]}
Response: the dict returned by _agent.run_turn.

Deliberately dependency-free: Vercel's Python runtime serves a class named
`handler` with no framework required, which keeps the bundle small and the cold
start short. All real work lives in _routes/_agent so the local dev server
behaves identically.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

try:
    from _routes import MAX_BODY_BYTES, chat_response
except ImportError:
    from api._routes import MAX_BODY_BYTES, chat_response  # type: ignore


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel requires this name
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "invalid_content_length"})
            return
        if length <= 0:
            self._send(400, {"error": "empty_body"})
            return
        if length > MAX_BODY_BYTES:
            self._send(413, {"error": "body_too_large", "max_bytes": MAX_BODY_BYTES})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            self._send(400, {"error": "invalid_json", "message": str(exc)})
            return

        self._send(*chat_response(payload))

    def do_GET(self) -> None:  # noqa: N802
        self._send(405, {"error": "method_not_allowed", "hint": "POST a JSON body to this endpoint"})

    def log_message(self, *args) -> None:  # keep the function logs readable
        return
