"""Behavioral resource and native-runner controls, not fixture project-gate claims."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import fixture

import guard


def native(command):
    """CLI controls are independent test runs, not recursive node:test children."""
    env = {k: v for k, v in os.environ.items() if k != "NODE_TEST_CONTEXT"}
    return subprocess.run(command, env=env, capture_output=True, timeout=15, check=False)


def verify(require):
    """Inject both independent metrics, cancel actual work, inspect actual bindings."""
    for failing in (None, "/workspace-fixture", "/docker-fixture", "unavailable"):
        calls = []

        def sample(path, calls=calls, failing=failing):
            calls.append(str(path))
            if failing == "unavailable":
                raise OSError("synthetic unavailable metric")
            return SimpleNamespace(f_bavail=2 * 1024**3 if str(path) == failing else 4 * 1024**3,
                                   f_frsize=1)
        try:
            result = guard.capacity("/workspace-fixture", "/docker-fixture", sample)
        except (RuntimeError, OSError):
            require(failing is not None, "valid metric rejected")
        else:
            require(failing is None, "unsafe metric accepted")
            require(calls == ["/workspace-fixture", "/docker-fixture"], "metrics not independently sampled")
            require(set(result) == {"workspace", "docker-root"}, "metric identities missing")
    with tempfile.TemporaryDirectory(prefix="dify-owned-control-") as work:
        pidfile = Path(work) / "pid"
        script = "import os,pathlib,select;pathlib.Path(" + repr(str(pidfile)) + ").write_text(str(os.getpid()));select.select([],[],[],30)"
        samples = 0

        def low_after_start():
            nonlocal samples
            samples += 1
            if samples > 1:
                deadline = time.monotonic() + 5
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                raise RuntimeError("synthetic storage floor")
        try:
            guard.guarded([sys.executable, "-c", script], sampler=low_after_start, timeout=10)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Low-space work not cancelled")
        require(pidfile.exists(), "cancellation positive control never started")
        pid = int(pidfile.read_text())
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            require(True, "owned child terminated and reaped")
        else:
            raise AssertionError("Owned work survived cancellation")
        require(guard.guarded([sys.executable, "-c", "pass"], sampler=lambda: None) == 0,
                "safe guarded work rejected")
        config = json.loads((guard.ROOT.parents[2] / ".sdd/config.json").read_text())
        target = Path(work) / "fixture.test.mjs"
        cases = {
            "valid": "import test from 'node:test';test('TEST-GUARD-001',()=>{});",
            "unmatched": "import test from 'node:test';test('OTHER',()=>{});",
            "skipped": "import test from 'node:test';test.skip('TEST-GUARD-001',()=>{});",
            "suite-only": "import {describe,test} from 'node:test';describe('TEST-GUARD-001',()=>test('other',()=>{}));",
            "duplicate": "import test from 'node:test';test('TEST-GUARD-001',()=>{});test('TEST-GUARD-001',()=>{});",
        }
        for name, content in cases.items():
            target.write_text(content)
            command = [a.replace("{id}", "TEST-GUARD-001").replace("{file}", str(target))
                       for a in config["testCmd"]]
            result = native(command)
            require((result.returncode == 0) == (name == "valid"), "native runner control: " + name)
        for suffix in ("missing.test.mjs", "no-matches-*.test.mjs"):
            command[-1] = str(Path(work) / suffix)
            require(native(command).returncode != 0,
                    "missing native test accepted")
        target.write_text("import test from 'node:test';" + "".join(
            f"test('TEST-DIFYIMG-{i:03}',()=>{{}});" for i in range(1, 7)))
        command = list(config["checks"][0]["cmd"])
        command[-1] = str(target)
        require(native(command).returncode == 0,
                "complete native runner control rejected")
        target.write_text("import test from 'node:test';test('TEST-DIFYIMG-001',()=>{});")
        require(native(command).returncode != 0,
                "missing required case accepted")
    state = json.loads(fixture.STATE.read_text())
    default_args = guard.run_args(guard.IMAGE, state["public_key"], state["volume"], state["owner"])
    published = [default_args[i + 1] for i, arg in enumerate(default_args) if arg == "--publish"]
    require(published == ["127.0.0.1:8080:80", "127.0.0.1:2222:22"],
            "real wrapper default loopback bindings differ")
    obj = fixture.owned(state)
    hc = obj["HostConfig"]
    configured = hc["PortBindings"]
    require(set(configured) == {"80/tcp", "22/tcp"} and
            all(len(bindings) == 1 and bindings[0]["HostIp"] == "127.0.0.1"
                for bindings in configured.values()), "configured fixture loopback bindings differ")
    active = {port: obj["NetworkSettings"]["Ports"][port] for port in ("80/tcp", "22/tcp")}
    require(active == {
        "80/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(state.get("http_port", 8080))}],
        "22/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(state.get("ssh_port", 2222))}]},
        "actual fixture loopback bindings differ")
    require(not hc["Privileged"] and hc["NetworkMode"] != "host", "privileged/host network")
    require(set(hc["CapAdd"]) <= {"CHOWN", "SETUID", "SETGID", "KILL", "SYS_CHROOT",
                                   "CAP_CHOWN", "CAP_SETUID", "CAP_SETGID", "CAP_KILL", "CAP_SYS_CHROOT"},
            "capability ceiling")
    require(len(hc["Mounts"]) == 2 and {m["Target"] for m in hc["Mounts"]} == {"/data", "/run/authorized_keys"},
            "unexpected host mount")
    volume = json.loads(fixture.docker(["volume", "inspect", state["volume"]]).stdout)[0]
    require(volume["Labels"][guard.LABEL] == state["owner"], "owned volume label")
    image = json.loads(fixture.docker(["image", "inspect", guard.IMAGE]).stdout)[0]
    require(bool(image["Config"]["Labels"].get(guard.LABEL)), "owned image label")
