"""Local dev API server - the stand-in for Vercel's Python functions.

`next dev` does not execute api/*.py, so this serves the same routes on
http://127.0.0.1:8787 and next.config.ts rewrites /api/* to it in development.
Teammates therefore need Python and Node, but not a Vercel account or login.

    python scripts/local_api.py

Routing and responses come from api/_routes.py, the same module the deployed
functions use, so local behaviour matches production.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

UI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(UI_ROOT / "api"))

from _routes import (  # noqa: E402
    MAX_BODY_BYTES,
    chat_response,
    history_delete_response,
    history_get_response,
    history_list_response,
    meta_response,
)

HOST = "127.0.0.1"
PORT = 8787


class Handler(BaseHTTPRequestHandler):
    server_version = "day04-local-api"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        query = parse_qs(parsed.query)
        if path in ("/api/meta", "/meta"):
            self._send(*meta_response())
        elif path in ("/api/history", "/history"):
            conversation_id = (query.get("id") or [None])[0]
            if conversation_id:
                self._send(*history_get_response(conversation_id))
            else:
                try:
                    limit = int((query.get("limit") or ["50"])[0])
                except ValueError:
                    limit = 50
                self._send(*history_list_response(limit))
        else:
            self._send(404, {"error": "not_found", "path": path})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") not in ("/api/history", "/history"):
            self._send(404, {"error": "not_found", "path": parsed.path})
            return
        conversation_id = (parse_qs(parsed.query).get("id") or [None])[0]
        self._send(*history_delete_response(conversation_id))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/")
        if path not in ("/api/chat", "/chat"):
            self._send(404, {"error": "not_found", "path": path})
            return
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

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[local-api] {fmt % args}\n")


def main() -> None:
    from _agent import DEFAULT_MODEL, LAB_ROOT  # noqa: PLC0415 - after sys.path setup

    print(f"[local-api] lab package: {LAB_ROOT}")
    print(f"[local-api] model:       {DEFAULT_MODEL}")
    print(f"[local-api] listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
