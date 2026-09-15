"""GET /api/meta - what the UI shows before the first turn.

Reports the artifact version and hashes computed from the files actually on
disk, so the header can never claim a version the deployment is not running.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

try:
    from _routes import meta_response
except ImportError:
    from api._routes import meta_response  # type: ignore


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel requires this name
    def do_GET(self) -> None:  # noqa: N802
        status, payload = meta_response()
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        return
