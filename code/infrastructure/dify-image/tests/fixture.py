"""Owned integration fixture; tokens and test private keys are never printed."""
import fcntl
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import guard

WORK = Path.home() / ".cache" / "ghc-dify" / "validation"
STATE = WORK / "state.json"


def stop_owned():
    """Emergency stop remains possible when capacity sampling itself has failed."""
    if not STATE.exists():
        return
    state = json.loads(STATE.read_text())
    inspected = subprocess.run(["docker", "inspect", state["container"]],
                               capture_output=True, text=True, timeout=15, check=False)
    if inspected.returncode:
        return
    obj = json.loads(inspected.stdout)[0]
    if obj["Config"]["Labels"].get(guard.LABEL) != state["owner"]:
        raise RuntimeError("Emergency-stop owner mismatch")
    if obj["State"]["Running"]:
        subprocess.run(["docker", "stop", "--time", "20", state["container"]],
                       capture_output=True, timeout=30, check=True)


def docker(args, data=None, check=True, timeout=30):
    """Bounded native Docker operation with independent capacity measurements."""
    try:
        guard.capacity()
    except Exception:
        stop_owned()
        raise
    result = subprocess.run(["docker", *args], input=data, text=True,
                            capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise RuntimeError("Owned Docker operation failed: " + args[0])
    return result


def save(state):
    """Persist only private fixture metadata; no host credentials are imported."""
    WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = STATE.with_name("state.tmp")
    temporary.write_text(json.dumps(state))
    temporary.chmod(0o600)
    temporary.replace(STATE)


def owned(state):
    """A stored ID is not cleanup authority unless its exact owner label matches."""
    obj = json.loads(docker(["inspect", state["container"]]).stdout)[0]
    if obj["Config"]["Labels"].get(guard.LABEL) != state["owner"]:
        raise RuntimeError("Fixture container owner mismatch")
    return obj


def cleanup(state):
    """Remove only exact fixture resources after checking both labels."""
    owned(state)
    docker(["rm", "--force", state["container"]])
    volume = json.loads(docker(["volume", "inspect", state["volume"]]).stdout)[0]
    if volume.get("Labels", {}).get(guard.LABEL) != state["owner"]:
        raise RuntimeError("Fixture volume owner mismatch")
    docker(["volume", "rm", state["volume"]])


def refresh_ports(state, obj):
    """Docker may reassign ephemeral host ports after kill/start of the same ID."""
    for name, port in (("http_port", "80/tcp"), ("ssh_port", "22/tcp")):
        bindings = obj["NetworkSettings"]["Ports"][port]
        if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
            raise RuntimeError("Fixture must publish one loopback binding")
        state[name] = int(bindings[0]["HostPort"])
    # Role-failure waves pass copies of the primary state. They must never
    # overwrite the primary fixture receipt with one of their transient IDs.
    if STATE.exists():
        stored = json.loads(STATE.read_text())
        if stored["container"] == state["container"] and stored["owner"] == state["owner"]:
            save(state)


def launch(state, *, volume=None):
    """Start the one final image/container with only keys and its data volume mounted."""
    name = "okayama-u-dify-validation-" + uuid.uuid4().hex[:8]
    argv = guard.run_args(guard.IMAGE, state["public_key"], volume or state["volume"], state["owner"])
    # Keep the real wrapper's defaults separately asserted by TEST006, while
    # qualification never claims ports belonging to a running user deployment.
    argv = [{"127.0.0.1:8080:80": "127.0.0.1::80",
             "127.0.0.1:2222:22": "127.0.0.1::22"}.get(a, a) for a in argv]
    argv[-1:-1] = ["--name", name]
    cid = subprocess.check_output(argv, text=True).strip()
    state["container"] = cid
    save(state)
    refresh_ports(state, owned(state))
    return cid


def ready(state, timeout=330):
    """Poll every required role via aggregate health; crash/deadline is a failure."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        obj = owned(state)
        if not obj["State"]["Running"]:
            raise RuntimeError("Fixture exited during startup")
        if obj["State"].get("Health", {}).get("Status") == "healthy":
            refresh_ports(state, obj)
            return
        time.sleep(1)
    raise RuntimeError("Fixture all-role readiness deadline")


def _get():
    """Reuse a live current-image fixture, never an old image or unrelated volume."""
    image = json.loads(docker(["image", "inspect", guard.IMAGE]).stdout)[0]
    if STATE.exists():
        state = json.loads(STATE.read_text())
        current = owned(state)
        if state["image"] == image["Id"]:
            if not current["State"]["Running"]:
                raise RuntimeError("Existing fixture failed; inspect redacted logs before retry")
            ready(state)
            return state
        # A local image update must exercise the same persistent data, not hide
        # incompatible bootstrap/configuration changes by deleting its volume.
        if current["State"]["Running"]:
            docker(["stop", "--time", "20", state["container"]], timeout=30)
        docker(["rm", state["container"]])
        state["image"] = image["Id"]
        launch(state)
        ready(state)
        return state
    WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
    private = WORK / "test_ed25519"
    if not private.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(private)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    owner = "validation-" + str(uuid.uuid4())
    volume = "okayama-u-dify-validation-" + uuid.uuid4().hex[:12]
    state = {"owner": owner, "volume": volume, "image": image["Id"],
             "private_key": str(private), "public_key": str(private) + ".pub",
             "admin_password": secrets.token_urlsafe(24) + "Aa1!"}
    docker(["volume", "create", "--label", f"{guard.LABEL}={owner}", volume])
    launch(state)
    ready(state)
    return state


def get():
    """Serialize image replacement so parallel bounded probes cannot race data."""
    WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (WORK / "fixture.lock").open("a") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _get()


def execute(state, code, *, user=None, data=None, timeout=60, check=True):
    """Run fixture assertions without exposing role-private environment copies."""
    args = ["exec", "-i"]
    if user:
        args += ["--user", str(user)]
    args += [state["container"], "/usr/local/bin/python3", "-c", code]
    return docker(args, data, check=check, timeout=timeout)


if __name__ == "__main__":
    try:
        state = get()
        print(json.dumps({"ready": True, "container": state["container"]}))
    except Exception as error:  # noqa: BLE001 -- fixture boundary must fail closed
        if STATE.exists():
            state = json.loads(STATE.read_text())
            print(docker(["logs", "--tail", "30", state["container"]], check=False).stdout, file=sys.stderr)
        print(json.dumps({"ready": False, "error": str(error)}))
        raise SystemExit(1)
