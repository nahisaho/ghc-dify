"""Shared fixed identities and bounded privilege transitions."""
import ctypes
import json
import os
import re
import subprocess
from pathlib import Path

BASE = Path("/opt/dify-image/runtime")
DATA = Path("/data")
IDS = {"api": 1101, "worker": 1102, "beat": 1103, "web": 1104, "plugin": 1105,
       "shellctl": 1106, "agent": 1107, "postgres": 1108, "redis": 1109,
       "squid": 1110, "agent_squid": 1111, "nginx": 1112, "dev": 2000,
       "sandbox": 0, "shell_broker": 0, "sshd": 0}
CAPS_BROKER = sum(1 << n for n in (0, 6, 7, 18))


def gid(role):
    """Keep shared API storage in one primary group; no supplementary groups."""
    return 1200 if role in ("api", "worker", "beat") else IDS[role]


def identity(role):
    """Return a child-only credential transition with no saved root identity."""
    def drop():
        os.setgroups([])
        os.setgid(gid(role))
        os.setuid(IDS[role])
        os.umask(0o007 if role in ("api", "worker", "beat") else 0o077)
    return drop


def broker_caps():
    """Reduce operative root capabilities before exec; never add a capability."""
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Cap(ctypes.Structure):
        _fields_ = [(k, ctypes.c_uint32) for k in ("effective", "permitted", "inheritable")]
    libc = ctypes.CDLL(None, use_errno=True)
    values = (Cap * 2)(Cap(CAPS_BROKER, CAPS_BROKER, 0), Cap(0, 0, 0))
    if libc.capset(ctypes.byref(Header(0x20080522, 0)), values) != 0:
        raise RuntimeError("Cannot reduce broker capabilities")
    os.setgroups([])


def read_as(path, role):
    """Read an owner-private persisted file without DAC override capabilities."""
    os.seteuid(IDS[role])
    try:
        return Path(path).read_text()
    finally:
        os.seteuid(0)


def env_for(role):
    """Only provide a role its own persisted environment, never host credentials."""
    return json.loads(read_as(DATA / "secrets" / role / "env.json", role))


def run(role, argv, *, env=None, cwd="/", data=None, timeout=60):
    """Run bounded setup/probe commands without printing bodies or credentials."""
    # Popen chdirs before its preexec credential transition. GNU env changes
    # directory only after exec has dropped identity, so root needs no DAC bypass.
    return subprocess.run(["/usr/bin/env", "--chdir=" + cwd, *argv],
                          env=env or env_for(role), cwd="/",
                          input=data, text=True, capture_output=True,
                          user=IDS[role], group=gid(role), extra_groups=[],
                          umask=0o007 if role in ("api", "worker", "beat") else 0o077,
                          timeout=timeout, check=True)


def redact(text, keys):
    """Remove known credentials and all native MCP credential-bearing paths."""
    for key in keys:
        if key:
            text = text.replace(key, "[REDACTED]")
    return re.sub(r"(?i)(https?://\S*?/mcp/|/mcp/)[^\s\"']+", "[MCP-REDACTED]", text)
