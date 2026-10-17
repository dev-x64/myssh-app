#!/usr/bin/env python3
"""Uploads a release to the cloud server's panel, as scripts/release.sh
leaves it in release/<version>/, with the token made for that on the
panel's settings page ("Выпуски" tab).

    scripts/release-upload.py <server> <folder>

The token is MYSSH_PANEL_TOKEN, or else the contents of
~/.myssh/panel-token. Each file goes up in parts of 8 MB (Cloudflare, in
front of the server, takes no request over 100 MB), a part that fails is
tried again from where the server says the file stands, and then the
server is told to take them all as one release. It is uploaded, not sent:
the address of the page to look it over and send it from is what it
prints (progress goes to stderr).
"""

import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PART = 8 * 1024 * 1024
TRIES = 4


def token() -> str:
    given = os.environ.get("MYSSH_PANEL_TOKEN", "").strip()
    if given:
        return given
    path = Path.home() / ".myssh" / "panel-token"
    return path.read_text().strip() if path.is_file() else ""


def ask(server: str, path: str, body: bytes, kind: str, key: str) -> tuple[int, dict]:
    request = urllib.request.Request(
        server + path,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": kind, "User-Agent": "MySSH-release"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as answer:
            return answer.status, json.loads(answer.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            said = json.loads(error.read() or b"{}")
        except ValueError:
            said = {}
        return error.code, said
    except (urllib.error.URLError, TimeoutError) as error:
        # No answer at all: tried again like any other failure.
        return 0, {"error": str(getattr(error, "reason", error))}


def size(count: float) -> str:
    return f"{count / 1048576:.1f} МБ"


def main() -> int:
    server, folder = sys.argv[1].rstrip("/"), Path(sys.argv[2])
    key = token()
    if not key:
        print("нет токена панели (MYSSH_PANEL_TOKEN или ~/.myssh/panel-token)", file=sys.stderr)
        return 2
    files = sorted(p for p in folder.iterdir() if p.is_file() and not p.name.startswith("."))
    total = sum(p.stat().st_size for p in files)
    stage = secrets.token_hex(16)
    # An empty part first: a token that does not fit is refused before the
    # server has a part it would not read (and the refusal is then readable).
    query = urllib.parse.urlencode({"stage": stage, "name": "latest.json", "offset": 0})
    status, said = ask(server, f"/admin/updates/stage?{query}", b"", "application/octet-stream", key)
    if status != 200:
        print(f"панель не пускает: {said.get('error') or f'ответ {status}'}", file=sys.stderr)
        return 1
    done = 0
    for file in files:
        length, offset = file.stat().st_size, 0
        with open(file, "rb") as data:
            while offset < length or (length == 0 and offset == 0):
                data.seek(offset)
                chunk = data.read(PART)
                query = urllib.parse.urlencode({"stage": stage, "name": file.name, "offset": offset})
                for attempt in range(TRIES):
                    status, said = ask(server, f"/admin/updates/stage?{query}", chunk, "application/octet-stream", key)
                    if status in (200, 409) and "size" in said:
                        break
                    if status in (401, 404) or attempt == TRIES - 1:
                        reason = said.get("error") or f"сервер ответил {status}"
                        print(f"\nне загрузилось: {file.name} — {reason}", file=sys.stderr)
                        return 1
                    time.sleep(attempt + 1)
                offset = said["size"]
                print(f"\r  {file.name} · {size(done + offset)} из {size(total)}\033[K", end="", file=sys.stderr, flush=True)
                if length == 0:
                    break
        done += length
    print(file=sys.stderr)
    status, said = ask(server, "/admin/updates/upload", urllib.parse.urlencode({"stage": stage}).encode(),
                       "application/x-www-form-urlencoded", key)
    if status != 200 or "look_over" not in said:
        print(f"сервер не принял выпуск: {said.get('error') or f'ответ {status}'}", file=sys.stderr)
        return 1
    print(said["look_over"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
