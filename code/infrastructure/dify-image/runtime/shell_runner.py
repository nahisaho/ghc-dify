#!/usr/local/bin/python3
"""Stock shellctl runner artifact protocol, delegated to the root jail broker."""
import base64
import datetime
import json
import os
import select
import signal
import socket
import sys
import time
from contextlib import ExitStack
from pathlib import Path


def atomic(path, content):
    """Publish exactly the completion artifacts expected by pinned shellctl."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content + "\n")
    tmp.replace(path)


def output_file(path):
    """Transfer a binary stream to the job's ExitStack for bounded ownership."""
    return path.open("wb", buffering=0)


def main():
    """Keep control-plane state out of the executed job's root and environment."""
    if len(sys.argv) < 4:
        return 125
    job = Path(sys.argv[1])
    cwd = sys.argv[3]
    mode = sys.argv[4] if len(sys.argv) > 4 else "pty"
    deadline = time.monotonic() + 60
    while not (job / "start-gate").is_file():
        if time.monotonic() >= deadline:
            return 125
        select.select([], [], [], 0.005)
    overlay = json.loads((job / ".job-env.json").read_text()) or {} if (job / ".job-env.json").exists() else {}
    request = {"script": (job / "script").read_text(), "cwd": cwd,
               "env": overlay, "timeout": 3600}
    sock = socket.socket(socket.AF_UNIX)
    sock.connect("/run/dify/shell-broker.sock")
    sock.settimeout(30)
    sock.sendall(json.dumps(request).encode() + b"\n")
    acknowledgement = b""
    while not acknowledgement.endswith(b"\n") and len(acknowledgement) < 64:
        byte = sock.recv(1)
        if not byte:
            raise RuntimeError("Broker closed before admission")
        acknowledgement += byte
    if json.loads(acknowledgement) != {"ready": True}:
        raise RuntimeError("Broker admission failed")
    sock.settimeout(None)

    def interrupt(number, frame):
        try:
            sock.sendall(b'{"signal":"INT"}\n')
        except OSError:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    files = None
    files_context = ExitStack()
    if mode == "stdio":
        files = {stream: files_context.enter_context(output_file(job / name)) for stream, name in
                 (("stdout", "output.log"), ("stderr", "stderr.log"))}
        sock.sendall(b'{"eof":true}\n')
    buffer = b""
    status = 125
    inputs = [sock] + ([sys.stdin] if mode != "stdio" else [])
    try:
        while True:
            readable, _, _ = select.select(inputs, [], [], 3700)
            if not readable:
                raise RuntimeError("Broker response deadline")
            for source in readable:
                if source is not sock:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        inputs.remove(sys.stdin)
                        sock.sendall(b'{"eof":true}\n')
                    else:
                        sock.sendall(json.dumps({"input": base64.b64encode(data).decode()}).encode() + b"\n")
                    continue
                block = sock.recv(65536)
                if not block:
                    raise RuntimeError("Broker exited before confirmed cleanup")
                buffer += block
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    message = json.loads(line)
                    if "exit_code" in message:
                        status = message["exit_code"]
                        return status
                    content = base64.b64decode(message["data"], validate=True)
                    stream = message["stream"]
                    if files:
                        files[stream].write(content)
                    else:
                        os.write(2 if stream == "stderr" else 1, content)
    finally:
        sock.close()
        files_context.close()
        atomic(job / "runner-exit-code", str(status))
        atomic(job / "runner-ended-at", datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:  # noqa: BLE001 -- redact all launcher exceptions and fail closed
        print("shell job launcher failed closed", file=sys.stderr)
        raise SystemExit(125)
