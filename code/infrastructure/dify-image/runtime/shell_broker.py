"""Trusted root launcher: peer-authenticated requests, private roots and cap0 jobs."""
import base64
import json
import math
import os
import selectors
import shutil
import socket
import stat
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path

from common import IDS, broker_caps
from shell_state import (
    HOME,
    ROOTS,
    UID,
    UnsafeState,
    commit_home,
    erase_root,
    ownership,
    recover_home,
    recover_roots,
)

SOCKET = "/run/dify/shell-broker.sock"


class JobError(Exception):
    """Expected client/job/resource failure; only report after verified cleanup."""

    def __init__(self, category, status=125):
        super().__init__(category)
        self.category = category
        self.status = status


def clean_uid():
    """A same-UID helper signals jobs; root broker never needs CAP_KILL."""
    try:
        subprocess.run(["/usr/local/bin/python3", "/usr/local/lib/dify-image/kill_job.py", str(UID)],
                       env={}, cwd="/", timeout=15, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise UnsafeState("Cannot confirm leased UID cleanup") from error


def emit(connection, **message):
    """Frame output without logging request contents."""
    connection.sendall(json.dumps(message).encode() + b"\n")


def decode_frame(data):
    """Malformed peer JSON is not evidence that a cleanup invariant was lost."""
    try:
        message = json.loads(data)
    except (ValueError, RecursionError) as error:
        raise JobError("invalid_frame") from error
    if not isinstance(message, dict):
        raise JobError("invalid_frame")
    return message


def execute(connection, request):
    """Serialize a job; persist its home only after all descendants are gone."""
    script = request.get("script")
    if not isinstance(script, str):
        raise JobError("invalid_script")
    try:
        if len(script.encode()) > 1024 * 1024:
            raise JobError("invalid_script")
    except UnicodeError as error:
        raise JobError("invalid_script") from error
    cwd = request.get("cwd", "/home/dify")
    overlay = request.get("env", {})
    if not isinstance(cwd, str) or not isinstance(overlay, dict):
        raise JobError("invalid_request")
    cwd = cwd.replace("/data/shellctl/home", "/home/dify", 1)
    if cwd == "/data/shellctl/daemon":
        cwd = "/home/dify"
    if not (cwd == "/home/dify" or cwd.startswith("/home/dify/")) or ".." in Path(cwd).parts:
        raise JobError("invalid_cwd")
    try:
        timeout = min(max(float(request.get("timeout", 300)), 1), 3600)
    except (TypeError, ValueError, OverflowError) as error:
        raise JobError("invalid_timeout") from error
    if not math.isfinite(timeout):
        raise JobError("invalid_timeout")
    clean_uid()
    root = ROOTS / str(uuid.uuid4())
    workspace = root / "home/dify"
    # Only caller-supplied job environment survives; inherited daemon auth never does.
    blocked = ("LD_", "PYTHON", "SHELLCTL_", "TMUX", "API_KEY", "REDIS", "DB_", "SECRET")
    env = {k: v for k, v in overlay.items() if isinstance(k, str) and isinstance(v, str)
           and not k.startswith(blocked) and "\0" not in k + v}
    env.update(HOME="/home/dify", PATH="/usr/local/bin:/usr/bin:/bin",
               TMPDIR="/tmp", TMP="/tmp", TEMP="/tmp", LANG="C.UTF-8",
               # The jail has these immutable libraries, not the host ld cache.
               # This trusted path is applied only to the already-cap0 child.
               LD_LIBRARY_PATH="/usr/local/lib:/usr/lib/x86_64-linux-gnu")

    def drop():
        os.chroot(root)
        os.chdir("/")
        os.setgroups([])
        os.setgid(1000)
        os.setuid(UID)  # all real/effective/saved credentials leave root
        # The private workspace is0700/job-owned; root intentionally has no DAC
        # bypass. Enter it only after dropping identity, just as service cwd does.
        os.chdir(cwd)

    process = None
    waiter = None
    try:
        subprocess.run(["cp", "-al", "/opt/job-root", str(root)], check=True, timeout=30)
        root.chmod(0o755)
        workspace.rmdir()
        ownership(HOME, 0, 0)
        try:
            shutil.copytree(HOME, workspace, symlinks=True)
        finally:
            ownership(HOME, IDS["shellctl"], IDS["shellctl"])
        ownership(workspace, UID, 1000)
        os.chmod(root / "tmp", 0o700)
        (root / "dev/null").unlink()
        (root / "dev/null").touch(mode=0o666)
        os.chmod(root / "dev/null", 0o666)
        os.chown(root / "dev/null", UID, 1000)
        command = root / "tmp/job.sh"
        command.write_text(script)
        command.chmod(0o400)
        os.chown(command, UID, 1000)
        os.chown(root / "tmp", UID, 1000)
        if threading.active_count() != 1:
            raise UnsafeState("Broker must be single-threaded before privilege-transition fork")
        process = subprocess.Popen(["/bin/bash", "/tmp/job.sh"], env=env, preexec_fn=drop,  # noqa: PLW1509 -- enforced single-threaded above
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
        os.set_blocking(process.stdin.fileno(), False)
        # Reap the direct child while same-UID cleanup checks the whole lease.
        # Waiting only AFTER cleanup leaves a zombie that cannot be signaled
        # away, making a correctly fail-closed cleanup deadline expire forever.
        waiter = threading.Thread(target=process.wait, daemon=True)
        waiter.start()
        stream_job(connection, process, timeout)
        clean_uid()
        status = process.wait(timeout=5)
        waiter.join(timeout=5)
        if waiter.is_alive():
            raise UnsafeState("Job reaper did not finish")
        ownership(workspace, 0, 0)
        commit_home(workspace)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise JobError("job_io_failure") from error
    finally:
        # Failure never permits a new job on uncertain cleanup.
        try:
            clean_uid()
            if process:
                process.wait(timeout=5)
                for pipe in (process.stdin, process.stdout, process.stderr):
                    if pipe:
                        pipe.close()
            if waiter:
                waiter.join(timeout=5)
                if waiter.is_alive():
                    raise UnsafeState("Cannot reuse a lease with a live reaper")
            if os.path.lexists(root):
                erase_root(root)
            recover_home()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise UnsafeState("Cannot confirm private state cleanup") from error
    emit(connection, exit_code=status if status >= 0 else 128 - status)


def stream_job(connection, process, timeout):
    """Bounded framed IPC; malformed authenticated traffic is an ordinary error."""
    with selectors.DefaultSelector() as selector:
        selector.register(connection, selectors.EVENT_READ, "input")
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        deadline = time.monotonic() + timeout
        buffer = b""
        outputs, total = 2, 0
        while outputs:
            if time.monotonic() >= deadline:
                raise JobError("timeout", 124)
            for key, _ in selector.select(timeout=0.25):
                if key.data == "input":
                    block = connection.recv(65536)
                    if not block:
                        raise JobError("disconnected")
                    buffer += block
                    if len(buffer) > 1024 * 1024:
                        raise JobError("input_limit")
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        message = decode_frame(line)
                        if message.get("signal"):
                            raise JobError("cancelled", 130)
                        if message.get("eof") and process.stdin and not process.stdin.closed:
                            process.stdin.close()
                        elif "input" in message and process.stdin and not process.stdin.closed:
                            if not isinstance(message["input"], str):
                                raise JobError("invalid_input")
                            data = base64.b64decode(message["input"], validate=True)
                            if process.stdin.write(data) != len(data):
                                raise JobError("stdin_backpressure")
                else:
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        outputs -= 1
                        continue
                    total += len(block)
                    if total > 16 * 1024 * 1024:
                        raise JobError("output_limit")
                    emit(connection, stream=key.data, data=base64.b64encode(block).decode())


def reply_error(connection, error):
    """Only disconnected peers may lose their terminal frame; never hide cleanup."""
    try:
        emit(connection, exit_code=error.status, error=error.category)
    except (BrokenPipeError, ConnectionResetError, TimeoutError):
        pass


def handle(connection):
    """Contain known client errors; UnsafeState and unexpected bugs remain fatal."""
    try:
        data = b""
        while not data.endswith(b"\n"):
            block = connection.recv(65536)
            if not block or len(data) + len(block) > 2 * 1024 * 1024:
                raise JobError("invalid_frame")
            data += block
        request = decode_frame(data)
    except (OSError, JobError):
        reply_error(connection, JobError("invalid_frame"))
        return
    try:
        emit(connection, ready=True)
        execute(connection, request)
    except JobError as error:
        reply_error(connection, error)
    except (BrokenPipeError, ConnectionResetError, TimeoutError):
        # Admission failed, or execute already confirmed its finally cleanup.
        pass


def main():
    """Accept only the dedicated shellctl UID using kernel peer credentials."""
    os.umask(0o077)
    broker_caps()
    clean_uid()
    recover_roots()
    recover_home()
    old_socket = Path(SOCKET)
    if os.path.lexists(old_socket):
        metadata = old_socket.lstat()
        if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != 0:
            raise RuntimeError("Invalid broker socket")
        old_socket.unlink()
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(SOCKET)
    os.chown(SOCKET, 0, IDS["shellctl"])
    os.chmod(SOCKET, 0o660)
    listener.listen(16)
    while True:
        connection, _ = listener.accept()
        with connection:
            _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != IDS["shellctl"]:
                continue
            connection.settimeout(30)
            handle(connection)


if __name__ == "__main__":
    main()
