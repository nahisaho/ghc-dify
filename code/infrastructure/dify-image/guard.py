#!/usr/bin/env python3
"""Owned Docker operations with fail-closed, independently sampled disk guards."""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LABEL = "io.okayama-u.dify-image.owner"
FLOOR = 3 * 1024**3
IMAGE = "okayama-u/dify-allinone:1.19.0-local"


# @id CODE-DIFYIMG-006 @implements REQ-DIFYIMG-006
def capacity(workspace=ROOT, docker_root=None, sample=os.statvfs):
    """Measure both locations even on one device; an unavailable metric is fatal."""
    if docker_root is None:
        result = subprocess.run(
            ["docker", "info", "--format", "{{.DockerRootDir}}"],
            check=True, capture_output=True, text=True, timeout=15,
        )
        docker_root = result.stdout.strip()
    if not docker_root or not Path(docker_root).is_absolute():
        raise RuntimeError("DockerRootDir is unavailable")
    values = {}
    for name, path in (("workspace", workspace), ("docker-root", docker_root)):
        stat = sample(path)
        values[name] = stat.f_bavail * stat.f_frsize
        if values[name] < FLOOR:
            raise RuntimeError(f"Capacity guard stopped: {name} has less than 3 GiB")
    return values


def guarded(argv, *, timeout=1200, sampler=capacity, emit=True):
    """Run a bounded public build command; stop its exact process group on failure."""
    sampler()
    process = subprocess.Popen(argv, start_new_session=True)
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None:
            sampler()
            if time.monotonic() >= deadline:
                raise TimeoutError("Owned command exceeded its deadline")
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                continue
        if process.returncode:
            raise RuntimeError(f"Owned command exited {process.returncode}")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=15)
    return process.returncode


def run_args(image, key, volume, owner, *, http=8080, ssh=2222, caps=None):
    """Construct loopback-only, unprivileged arguments without a host Docker socket."""
    key = Path(key)
    if key.is_symlink() or not key.is_file():
        raise ValueError("A regular authorized_keys file is required")
    key = key.resolve(strict=True)
    for port in (http, ssh):
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("Invalid host port")
    allowed = {"CHOWN", "FOWNER", "SETUID", "SETGID", "KILL", "SYS_CHROOT"}
    caps = allowed - {"FOWNER"} if caps is None else set(caps)
    if not caps <= allowed:
        raise ValueError("Capability exceeds the approved ceiling")
    if not owner or not volume or "/" in volume or "," in str(key):
        raise ValueError("Invalid ownership or mount argument")
    args = [
        "docker", "run", "--detach", "--pull=never", "--label", f"{LABEL}={owner}",
        "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
        "--sysctl=net.ipv4.ip_unprivileged_port_start=0",
        "--pids-limit=512", "--memory=8g",
        "--publish", f"127.0.0.1:{http}:80",
        "--publish", f"127.0.0.1:{ssh}:22",
        "--mount", f"type=volume,source={volume},target=/data",
        "--mount", f"type=bind,source={key},target=/run/authorized_keys,readonly",
    ]
    for cap in sorted(caps):
        args += ["--cap-add", cap]
    return args + [image]


def main():
    """Expose capacity inspection and bounded, labeled local builds only."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["doctor", "build", "run"])
    parser.add_argument("--target", default="runtime", choices=["runtime", "system-deps", "sandbox-runtime"])
    parser.add_argument("--tag", default=IMAGE)
    parser.add_argument("--authorized-keys")
    parser.add_argument("--volume", default="okayama-u-dify-data")
    parser.add_argument("--name", default="okayama-u-dify")
    parser.add_argument("--owner", default="local-dify-image")
    args = parser.parse_args()
    print(json.dumps({"freeBytes": capacity()}), flush=True)
    if args.action == "build":
        owner = str(uuid.uuid4())
        guarded([
            "docker", "build", "--progress=plain", "--target", args.target,
            "--label", f"{LABEL}={owner}", "--tag", args.tag, str(ROOT),
        ])
    elif args.action == "run":
        if not args.authorized_keys or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", args.volume):
            raise ValueError("A key file and a valid named volume are required")
        existing = subprocess.run(["docker", "volume", "inspect", args.volume],
                                  capture_output=True, text=True, check=False)
        if existing.returncode == 0:
            if json.loads(existing.stdout)[0].get("Labels", {}).get(LABEL) != args.owner:
                raise RuntimeError("Refusing unrelated volume")
        else:
            subprocess.run(["docker", "volume", "create", "--label",
                            f"{LABEL}={args.owner}", args.volume], check=True,
                           stdout=subprocess.DEVNULL)
        argv = run_args(args.tag, args.authorized_keys, args.volume, args.owner)
        argv[-1:-1] = ["--name", args.name]
        capacity()
        cid = subprocess.check_output(argv, text=True).strip()
        try:
            deadline = time.monotonic() + 330
            while time.monotonic() < deadline:
                capacity()
                state = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]["State"]
                if not state["Running"]:
                    raise RuntimeError("Owned container exited during startup; inspect redacted container logs")
                if state.get("Health", {}).get("Status") == "healthy":
                    print(json.dumps({"container": cid, "ready": True}), flush=True)
                    return
                time.sleep(1)
            raise TimeoutError("All-role startup deadline")
        except BaseException:
            obj = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
            if obj["Config"]["Labels"].get(LABEL) == args.owner:
                subprocess.run(["docker", "stop", "--time", "20", cid],
                               stdout=subprocess.DEVNULL, timeout=60, check=False)
            raise


if __name__ == "__main__":
    main()
