#!/usr/bin/env python3
"""Local live-discussion server for the Cowork retention table.

API:
  GET  /api/discussion   -> {version, threads}
  POST /api/comment      -> append a user message
  POST /api/reply        -> append an agent message
  POST /api/upload       -> store an image or text/markdown attachment
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path("/Users/ray/Workspace/dsh-cowork/docs/discussion")
STATE_FILE = ROOT / "cowork-sidebar-discussion.json"
UPLOAD_DIR = ROOT / "uploads"
LOCK = threading.Lock()

MAX_COMMENT_BODY = 100_000
MAX_UPLOAD_BODY = 12_000_000
MAX_TEXT = 4_000
MAX_FILES = 5
MAX_FILE_BYTES = 5 * 1024 * 1024
TEXT_EXTENSIONS = {".txt", ".md", ".markdown", ".json", ".csv", ".log"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"version": 0, "threads": {}}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 0, "threads": {}}
    if not isinstance(data, dict):
        return {"version": 0, "threads": {}}
    threads = data.get("threads")
    if not isinstance(threads, dict):
        threads = {}
    version = data.get("version")
    if not isinstance(version, int):
        version = 0
    return {"version": version, "threads": threads}


def save_state(state: dict) -> None:
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def safe_name(name: str) -> str:
    base = Path(str(name)).name.strip() or "attachment"
    base = re.sub(r"[^\w.\-]+", "_", base, flags=re.UNICODE).strip("._")
    return (base[:120] or "attachment")


def image_mime(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def save_upload(payload: dict) -> dict:
    name = safe_name(payload.get("name", ""))
    encoded = payload.get("data")
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("missing data")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("invalid base64") from error
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("file exceeds 5 MB")
    suffix = Path(name).suffix.lower()
    mime = str(payload.get("mime") or "")
    if suffix in IMAGE_EXTENSIONS or mime.startswith("image/"):
        detected = image_mime(raw)
        if detected is None:
            raise ValueError("unsupported image content")
        final_mime = detected
    elif suffix in TEXT_EXTENSIONS or mime.startswith("text/"):
        if b"\x00" in raw:
            raise ValueError("text file contains binary data")
        final_mime = "text/markdown" if suffix in {".md", ".markdown"} else "text/plain"
    else:
        raise ValueError("only images and text/markdown files are supported")
    file_id = uuid.uuid4().hex
    filename = f"{file_id}_{name}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / filename).write_bytes(raw)
    return {
        "id": file_id,
        "name": name,
        "mime": final_mime,
        "size": len(raw),
        "url": f"/uploads/{filename}",
    }


def clean_attachments(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_FILES:
        raise ValueError("invalid attachment list")
    cleaned = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("invalid attachment")
        name = safe_name(item.get("name", ""))
        mime = item.get("mime")
        size = item.get("size")
        url = item.get("url")
        if not isinstance(mime, str) or not isinstance(url, str):
            raise ValueError("invalid attachment fields")
        if not url.startswith("/uploads/") or ".." in url:
            raise ValueError("invalid attachment url")
        if not isinstance(size, int) or size < 0 or size > MAX_FILE_BYTES:
            raise ValueError("invalid attachment size")
        cleaned.append({"name": name, "mime": mime, "size": size, "url": url})
    return cleaned


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)

    def _json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, max_body: int) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > max_body:
            raise ValueError("invalid body size")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid json") from error
        if not isinstance(payload, dict):
            raise ValueError("object required")
        return payload

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/cowork-sidebar-retention.html")
            self.end_headers()
            return
        if path == "/api/discussion":
            with LOCK:
                self._json(load_state())
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/api/upload":
                payload = self._read_json(MAX_UPLOAD_BODY)
                attachment = save_upload(payload)
                self._json({"ok": True, "attachment": attachment})
                return
            if path not in ("/api/comment", "/api/reply"):
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            payload = self._read_json(MAX_COMMENT_BODY)
            item_id = payload.get("id")
            text = payload.get("text", "")
            if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 200:
                raise ValueError("invalid id")
            if not isinstance(text, str):
                raise ValueError("invalid text")
            text = text.strip()
            if len(text) > MAX_TEXT:
                raise ValueError("text too long")
            attachments = clean_attachments(payload.get("attachments"))
            if not text and not attachments:
                raise ValueError("text or attachment required")
            author = "user" if path == "/api/comment" else "agent"
            with LOCK:
                state = load_state()
                messages = state["threads"].get(item_id)
                if not isinstance(messages, list):
                    messages = []
                messages.append({
                    "author": author,
                    "text": text,
                    "attachments": attachments,
                    "at": datetime.now(timezone.utc).isoformat(),
                })
                state["threads"][item_id] = messages
                state["version"] += 1
                save_state(state)
                self._json(state)
        except ValueError as error:
            self._json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_POST_upload_placeholder(self) -> None:
        pass


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print(f"serving {ROOT} on http://127.0.0.1:8765", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
