"""Role-specific native readiness, plus Docker's fail-closed aggregate check."""
import json
import socket
import urllib.error
import urllib.request
from pathlib import Path

from common import run


def http(url, headers=None):
    """Fetch bounded local HTTP without printing request URLs or auth headers."""
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=3) as r:
        return r.read(100000)


def tcp(port, request=None):
    """Exercise a native wire protocol rather than merely testing a PID."""
    with socket.create_connection(("127.0.0.1", port), timeout=2) as s:
        if request:
            s.sendall(request)
        return s.recv(4096)


def check(role, envs):
    """Return one role's observed health; subprocess failures cannot count as ready."""
    try:
        if role == "postgres":
            r = run(role, ["psql", "-h", "/run/dify/postgres", "-U", "dify_postgres", "-d", "dify",
                           "-Atc", "select '[1,2]'::vector <-> '[1,2]'::vector"],
                    env=envs[role], timeout=5)
            return r.stdout.strip() == "0"
        if role == "redis":
            return run(role, ["redis-cli", "--no-auth-warning", "PING"],
                       env=envs[role], timeout=3).stdout.strip() == "PONG"
        if role == "api":
            return b"ok" in http("http://127.0.0.1:5001/health").lower()
        if role == "web":
            return b"<html" in http("http://127.0.0.1:3000").lower()
        if role == "nginx":
            return b"<html" in http("http://127.0.0.1:80").lower()
        if role == "plugin":
            return b"ok" in http("http://127.0.0.1:5002/health/check",
                                 {"X-Api-Key": envs[role]["SERVER_KEY"],
                                  "Authorization": "Bearer " + envs[role]["SERVER_KEY"]}).lower()
        if role == "sandbox":
            return b"ok" in http("http://127.0.0.1:8194/health").lower()
        if role == "agent":
            try:
                http("http://127.0.0.1:5050/runs/image-readiness-missing",
                     {"Authorization": "Bearer " + envs[role]["DIFY_AGENT_API_TOKEN"]})
            except urllib.error.HTTPError as error:
                return error.code == 404  # Auth + initialized Redis store, not a fictional health URL.
            return False
        if role == "shellctl":
            return b"ok" in http("http://127.0.0.1:5004/healthz").lower()
        if role == "shell_broker":
            return Path("/run/dify/shell-broker.sock").is_socket()
        if role == "sshd":
            return tcp(22).startswith(b"SSH-2.0-")
        if role in ("squid", "agent_squid"):
            port = 3128 if role == "squid" else 3129
            return b"403" in tcp(port, b"GET http://127.0.0.1:6379/ HTTP/1.0\r\n\r\n").split(b"\r\n")[0]
        if role == "worker":
            run(role, ["/app/api/.venv/bin/python", "-c",
                       ("import os;from celery import Celery;"
                       "client=Celery(broker=os.environ['CELERY_BROKER_URL']);"
                       "assert client.control.inspect(timeout=2).ping()")],
                env=envs[role], cwd="/app/api", timeout=15)
            return True
        if role == "beat":
            run(role, ["/app/api/.venv/bin/python", "-c",
                       "import redis,os;assert redis.Redis.from_url(os.environ['CELERY_BROKER_URL']).get('dify-image:beat')==b'ok'"],
                env=envs[role], cwd="/app/api", timeout=5)
            return True
    except Exception:  # noqa: BLE001 -- every protocol failure must produce not-ready
        return False
    return False


if __name__ == "__main__":
    try:
        status = json.loads(Path("/run/dify/readiness.json").read_text())
        import time
        expected = {"postgres", "redis", "api", "worker", "beat", "web", "plugin",
                    "sandbox", "agent", "shellctl", "shell_broker", "squid", "agent_squid", "nginx", "sshd"}
        valid = set(status["roles"]) == expected and all(status["roles"].values())
        valid = valid and time.time() - status["timestamp"] < 45
        print("ready" if valid else "not-ready")
        raise SystemExit(0 if valid else 1)
    except (OSError, ValueError, KeyError):
        raise SystemExit(1)
