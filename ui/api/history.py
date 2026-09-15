"""Conversation history.

    GET    /api/history              list conversations, newest first
    GET    /api/history?id=<uuid>    one conversation with all of its turns
    DELETE /api/history?id=<uuid>    remove a conversation and its turns

All access runs through this function using the service role key. The browser
holds no database credential, so there is nothing in the client bundle that can
read or forge a row.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

try:
    from _routes import history_delete_response, history_get_response, history_list_response
except ImportError:
    from api._routes import (  # type: ignore
        history_delete_response,
        history_get_response,
        history_list_response,
    )


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel requires this name
    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        query = self._query()
        conversation_id = (query.get("id") or [None])[0]
        if conversation_id:
            self._send(*history_get_response(conversation_id))
            return
        try:
            limit = int((query.get("limit") or ["50"])[0])
        except ValueError:
            limit = 50
        self._send(*history_list_response(limit))

    def do_DELETE(self) -> None:  # noqa: N802
        conversation_id = (self._query().get("id") or [None])[0]
        self._send(*history_delete_response(conversation_id))

    def log_message(self, *args) -> None:
        return
