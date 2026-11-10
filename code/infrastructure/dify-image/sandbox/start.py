#!/usr/bin/env python3
"""Fail closed unless a qualification launch supplies a fresh runtime key."""
import os
import re
import sys
from pathlib import Path


def main():
    """Reject the upstream demonstration key and excessive broker capabilities."""
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    permitted = (1 << 0) | (1 << 6) | (1 << 7) | (1 << 18)
    if os.getuid() != 0 or int(status["NoNewPrivs"]) != 1:
        raise RuntimeError("root/no-new-privileges policy")
    # The final supervisor retains KILL for cross-UID service shutdown, but this
    # trusted single-threaded entrypoint must discard it before execing Go.
    # The isolated component already starts with only the four broker caps.
    if any(int(status[field], 16) & (1 << 5) for field in ("CapEff", "CapPrm")):
        if any(int(status[field], 16) & ~(permitted | (1 << 5))
               for field in ("CapEff", "CapPrm")):
            raise RuntimeError("unexpected supervision capability")
        sys.path.insert(0, "/opt/dify-image/runtime")
        from common import broker_caps
        broker_caps()
        status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    for field in ("CapEff", "CapPrm"):
        if int(status[field], 16) & ~permitted:
            raise RuntimeError("broker capability ceiling")
    if any(int(status[field], 16) for field in ("CapInh", "CapAmb")):
        raise RuntimeError("unexpected inherited capabilities")
    key = os.environ.get("API_KEY", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,}", key):
        raise RuntimeError("fresh qualification API key required")
    os.execv("/opt/dify-sandbox/main", ["/opt/dify-sandbox/main"])


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- fail closed without printing any credential-bearing error
        print("sandbox qualification launch refused", file=sys.stderr)
        raise SystemExit(78)
