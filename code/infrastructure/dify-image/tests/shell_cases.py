"""Executed inside a disposable cap-bounded image; no real /data or credentials."""
import base64
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, "/opt/dify-image/runtime")
import shell_broker as broker

HOME = Path("/data/shellctl/home")
ROOTS = Path("/run/dify/shell-roots")
SOCKET = Path("/run/dify/shell-broker.sock")
CHILD = """
import errno,os,sys,shutil
from pathlib import Path
sys.path.insert(0,'/opt/dify-image/runtime')
import shell_broker as b
fault=sys.argv[1]
injected=False
original_copy=shutil.copytree
def copy(src,dst,*a,**kw):
 global injected
 if Path(dst)==b.HOME.with_name('home.next') and fault=='copy_error' and not injected:
  injected=True;Path(dst).mkdir(mode=0o700);raise OSError(errno.ENOSPC,'injected copy')
 if Path(dst)==b.HOME.with_name('home.next') and fault=='copy':
  Path(dst).mkdir(mode=0o700);Path(dst,'partial').write_text('incomplete');os._exit(73)
 result=original_copy(src,dst,*a,**kw)
 if Path(dst)==b.HOME.with_name('home.next') and fault=='copied':os._exit(73)
 return result
shutil.copytree=copy
original_rename=Path.rename
def rename(src,dst):
 global injected
 if src==b.HOME.with_name('home.next') and fault=='rename_error' and not injected:
  injected=True;raise OSError(errno.ENOSPC,'injected rename')
 if src==b.HOME.with_name('home.next') and fault=='before_install':os._exit(73)
 result=original_rename(src,dst)
 if src==b.HOME and fault=='old_rename':os._exit(73)
 if src==b.HOME.with_name('home.next') and fault=='installed':os._exit(73)
 return result
Path.rename=rename
if fault=='unsafe_cleanup':
 original_clean=b.clean_uid
 calls=0
 def clean():
  global calls
  calls+=1
  if calls==3:raise b.UnsafeState('injected uncertain cleanup')
  original_clean()
 b.clean_uid=clean
b.main()
"""


def remove(path):
    """Test reset only, after killing the exact broker and its entire leased UID."""
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
        return
    os.chown(path, 0, 0)
    path.chmod(0o700)
    for child in path.iterdir():
        remove(child)
    path.rmdir()


def reset():
    """Every case starts with synthetic HOME and an empty disposable root registry."""
    broker.clean_uid()
    for path in (HOME, HOME.with_name("home.next"), HOME.with_name("home.previous"), ROOTS):
        if os.path.lexists(path):
            remove(path)
    SOCKET.unlink(missing_ok=True)
    HOME.parent.mkdir(parents=True, exist_ok=True)
    HOME.parent.chmod(0o750)
    os.chown(HOME.parent, 0, 1106)
    HOME.mkdir(mode=0o700)
    (HOME / "marker").write_text("old")
    os.chown(HOME / "marker", 1106, 1106)
    os.chown(HOME, 1106, 1106)
    ROOTS.mkdir(mode=0o700, parents=True)


def start(fault=""):
    """Launch the actual broker with optional test-only filesystem fault injection."""
    SOCKET.unlink(missing_ok=True)
    process = subprocess.Popen([sys.executable, "-c", CHILD, fault],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if process.poll() is not None or SOCKET.is_socket():
            return process
        time.sleep(0.01)
    raise AssertionError("Broker startup did not settle")


def stop(process):
    """The test parent retains only the approved supervisor KILL exception."""
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)
    if process.stderr:
        detail = process.stderr.read(8000)
        if detail:
            print(detail.decode(errors="replace"), file=sys.stderr)
        process.stderr.close()
    broker.clean_uid()


def connect():
    """Admission is exercised as the real shellctl peer UID/GID, not root."""
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(12)
    os.setegid(1106)
    os.seteuid(1106)
    try:
        connection.connect(str(SOCKET))
    finally:
        os.seteuid(0)
        os.setegid(0)
    return connection


def begin(script, extra=None):
    """Send an authentic job request and consume its admission frame."""
    connection = connect()
    request = {"script": script, "cwd": "/home/dify", "env": {}, "timeout": 20}
    request.update(extra or {})
    connection.sendall(json.dumps(request).encode() + b"\n")
    stream = connection.makefile("rb")
    assert json.loads(stream.readline()) == {"ready": True}, "Job not admitted"
    return connection, stream


def finish(connection, stream):
    """Drain output without retaining the output-limit fixture's 17 MiB."""
    output = b""
    try:
        for line in stream:
            event = json.loads(line)
            if "exit_code" in event:
                return event["exit_code"], output, event.get("error")
            if len(output) < 1024:
                output += base64.b64decode(event["data"])[:1024]
    finally:
        stream.close()
        connection.close()
    raise AssertionError("Missing terminal job result")


def control(process):
    """A valid job after each negative proves the broker and lease remain usable."""
    assert process.poll() is None, "Ordinary job error killed the broker"
    status, output, error = finish(*begin("printf CONTROL_OK"))
    assert status == 0 and output == b"CONTROL_OK" and error is None
    assert not list(ROOTS.iterdir()), "Private job roots survived confirmed completion"


def interrupted(fault):
    """Crash after partial copy, full copy, old rename, or new-home install."""
    process = start(fault)
    try:
        connection, stream = begin("printf new > marker")
        try:
            finish(connection, stream)
        except (AssertionError, OSError):
            pass
        assert process.wait(timeout=12) == 73, "Fault boundary was not reached"
    finally:
        stop(process)
    process = start()
    try:
        control(process)
        os.setegid(1106)
        os.seteuid(1106)
        try:
            assert (HOME / "marker").read_text() == ("new" if fault == "installed" else "old")
        finally:
            os.seteuid(0)
            os.setegid(0)
        assert not os.path.lexists(HOME.with_name("home.next"))
        assert not os.path.lexists(HOME.with_name("home.previous"))
    finally:
        stop(process)


def ordinary(kind):
    """User-created ephemeral nodes and malformed peer traffic are not TCB failure."""
    process = start(kind)
    try:
        scripts = {
            "fifo": "mkfifo ~/pipe; printf FIFO_OK",
            "socket": """python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.bind('/home/dify/socket')"; printf SOCKET_OK""",
            "disconnect": "printf START; sleep 60 & wait",
            "cancel": "printf START; sleep 60 & wait",
            "output": """python3 -c "import sys; sys.stdout.buffer.write(b'x'*(17*1024*1024))" """,
            "malformed_input": "sleep 60",
            "copy_error": "printf changed > marker",
            "rename_error": "printf changed > marker",
            "unsafe_cleanup": "true",
        }
        if kind == "runner_kill":
            job = HOME.parent / "test-runner"
            job.mkdir(mode=0o700, exist_ok=True)
            os.chown(job, 1106, 1106)
            os.setegid(1106)
            os.seteuid(1106)
            try:
                (job / "script").write_text("printf RUNNER_STARTED; sleep 60 & wait")
                (job / "start-gate").touch()
            finally:
                os.seteuid(0)
                os.setegid(0)
            runner = subprocess.Popen(
                ["/usr/local/bin/shellctl-runner", str(job), "unused", "/home/dify", "stdio"],
                user=1106, group=1106, extra_groups=[], env={},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 10
                while not list(ROOTS.iterdir()) and time.monotonic() < deadline:
                    assert runner.poll() is None
                    time.sleep(0.01)
                assert list(ROOTS.iterdir()), "Runner did not acquire a live lease"
                runner.kill()
                runner.wait(timeout=5)
                control(process)
            finally:
                if runner.poll() is None:
                    runner.kill()
                runner.wait(timeout=5)
                remove(job)
            return
        if kind == "malformed_frame":
            connection = connect()
            connection.sendall(b"{broken\n")
            stream = connection.makefile("rb")
        else:
            connection, stream = begin(scripts[kind])
        if kind == "disconnect":
            assert json.loads(stream.readline()).get("stream") == "stdout"
            stream.close()
            connection.close()
        else:
            if kind == "cancel":
                assert json.loads(stream.readline()).get("stream") == "stdout"
                connection.sendall(b'{"signal":"INT"}\n')
            elif kind == "malformed_input":
                connection.sendall(b"not-json\n")
            if kind == "unsafe_cleanup":
                try:
                    finish(connection, stream)
                except (AssertionError, OSError):
                    pass
                assert process.wait(timeout=8) != 0, "Unsafe cleanup was contained as an ordinary error"
                return
            status, _, error = finish(connection, stream)
            assert status == (0 if kind in ("fifo", "socket") else 125 if kind != "cancel" else 130)
            assert (error is None) == (kind in ("fifo", "socket"))
        control(process)
    finally:
        stop(process)


def unsafe(kind):
    """Unknown/foreign/symlinked recovery state must never be treated as garbage."""
    sentinel = Path("/data/sentinel")
    sentinel.mkdir(exist_ok=True)
    (sentinel / "value").write_text("UNTOUCHED")
    if kind == "home_symlink":
        remove(HOME)
        HOME.symlink_to(sentinel)
    else:
        candidate = ROOTS / (str(uuid.uuid4()) if kind != "unknown_root" else "unknown")
        if kind == "root_symlink":
            candidate.symlink_to(sentinel)
        else:
            candidate.mkdir()
            if kind == "foreign_root":
                os.chown(candidate, 2000, 2000)
    process = start()
    try:
        assert process.wait(timeout=8) != 0, "Unsafe recovery state accepted"
        assert (sentinel / "value").read_text() == "UNTOUCHED"
    finally:
        stop(process)


def main():
    """Return all independent case verdicts; host assertions enforce zero failures."""
    cases = [(name, lambda name=name: interrupted(name)) for name in
             ("copy", "copied", "old_rename", "before_install", "installed")]
    cases += [(name, lambda name=name: ordinary(name)) for name in
              ("fifo", "socket", "disconnect", "cancel", "output", "malformed_input",
               "malformed_frame", "runner_kill", "copy_error", "rename_error", "unsafe_cleanup")]
    cases += [(name, lambda name=name: unsafe(name)) for name in
              ("home_symlink", "root_symlink", "foreign_root", "unknown_root")]
    results = []
    for name, run in cases:
        reset()
        try:
            run()
            results.append({"case": name, "passed": True})
        except (AssertionError, OSError, ValueError, subprocess.SubprocessError) as error:
            results.append({"case": name, "passed": False, "failure": type(error).__name__,
                            "detail": str(error)[:200]})
    print(json.dumps(results))


if __name__ == "__main__":
    main()
