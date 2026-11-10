#!/usr/bin/env python3
"""Exit when the live discussion receives a new user message."""

import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8765/api/discussion"


def get_state():
    with urllib.request.urlopen(URL, timeout=5) as response:
        return json.load(response)


def user_markers(state):
    markers = []
    for item_id, messages in (state.get("threads") or {}).items():
        if not isinstance(messages, list) or not messages:
            continue
        last = messages[-1]
        if isinstance(last, dict) and last.get("author") == "user":
            markers.append((item_id, last.get("at"), last.get("text")))
    return markers


def main():
    baseline = user_markers(get_state())
    while True:
        time.sleep(2)
        try:
            state = get_state()
        except Exception:
            continue
        current = user_markers(state)
        if current != baseline:
            print(json.dumps({
                "event": "user_comment",
                "version": state.get("version"),
                "items": current,
            }, ensure_ascii=False), flush=True)
            return


if __name__ == "__main__":
    main()
