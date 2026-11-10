#!/usr/bin/env python3
"""Terminate exact PID handles for one leased sandbox UID without CAP_KILL."""
import os
import signal
import sys
import time
from pathlib import Path


def main():
    """Drop to a validated job UID before sending any signals."""
    if os.getuid() != 0 or len(sys.argv) != 2 or not sys.argv[1].isdigit():
        return 2
    uid = int(sys.argv[1])
    if not 10000 <= uid < 11000:
        return 2
    os.setgroups([])
    os.setgid(1000)
    os.setuid(uid)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        handles = []
        for item in Path("/proc").iterdir():
            if not item.name.isdigit() or int(item.name) == os.getpid():
                continue
            fd = None
            try:
                # Bind the handle before checking identity to avoid PID reuse.
                fd = os.pidfd_open(int(item.name))
                status = (item / "status").read_text()
                identities = next(line for line in status.splitlines() if line.startswith("Uid:"))
                if list(map(int, identities.split()[1:])) == [uid] * 4:
                    handles.append(fd)
                    fd = None
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        if not handles:
            return 0
        for fd in handles:
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        # Re-enumerate against a deadline; never assume that one sweep suffices.
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
