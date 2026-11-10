"""Native single-container PID1 workload supervisor: fail closed on any role."""
import grp
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import threading
import time
from pathlib import Path

from bootstrap import bootstrap
from common import BASE, DATA, IDS, env_for, gid, redact, run
from configure import web_settings
from probes import check

CHILDREN: dict[str, subprocess.Popen[str]] = {}
STOP = threading.Event()
ENVS: dict[str, dict[str, str]] = {}
KEYS: list[str] = []


def output(role, stream):
    """Redact role output before any line reaches the Docker log stream."""
    for line in iter(stream.readline, ""):
        print(f"[{role}] {redact(line.rstrip(), KEYS)}", flush=True)


def start(role, argv, cwd="/", env=None):
    """Start exactly one role with its fixed identity and isolated environment."""
    settings = {"env": env or ENVS[role], "cwd": "/", "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT, "text": True, "bufsize": 1, "start_new_session": True}
    # Both trusted broker entrypoints reduce their own capabilities before
    # opening listeners. Never run Python preexec code after log threads exist.
    if IDS[role] != 0:
        settings.update(user=IDS[role], group=gid(role), extra_groups=[], umask=0o007)
    process = subprocess.Popen(["/usr/bin/env", "--chdir=" + cwd, *argv], **settings)
    CHILDREN[role] = process
    threading.Thread(target=output, args=(role, process.stdout), daemon=True).start()
    return process


def alive():
    """Any dead required process terminates startup or runtime."""
    dead = [role for role, p in CHILDREN.items() if p.poll() is not None]
    if dead:
        raise RuntimeError("Required role exited: " + ",".join(dead))


def wait_role(role, deadline):
    """Wait for a native protocol response without hiding a crashed process."""
    while time.monotonic() < deadline and not STOP.is_set():
        alive()
        if check(role, ENVS):
            return
        STOP.wait(0.25)
    raise RuntimeError("Role readiness deadline: " + role)


def publish(roles):
    """Expose health and exact child IDs, never environment values or credentials."""
    p = Path("/run/dify/readiness.tmp")
    p.write_text(json.dumps({"timestamp": time.time(), "roles": roles,
                            "pids": {role: child.pid for role, child in CHILDREN.items()}}))
    p.chmod(0o644)
    p.replace("/run/dify/readiness.json")


def postgres(keys, deadline):
    """Initialize an empty cluster only; partial clusters cannot be repaired."""
    os.seteuid(IDS["postgres"])
    try:
        initialized = (DATA / "postgres/PG_VERSION").is_file()
        if not initialized and any((DATA / "postgres").iterdir()):
            raise RuntimeError("Interrupted PostgreSQL initialization")
    finally:
        os.seteuid(0)
    if not initialized:
        # Reopening /dev/stdin after setuid fails DAC on a root-owned input pipe.
        # Read the inherited FD directly, then use an owner-private temporary.
        command = """import os,subprocess,sys,tempfile
with tempfile.NamedTemporaryFile(mode='w',dir='/data/secrets/postgres') as f:
 f.write(sys.stdin.read());f.flush()
 subprocess.run(['/usr/lib/postgresql/17/bin/initdb','-D','/data/postgres',
  '-U','dify_postgres','--auth-local=peer','--auth-host=scram-sha-256','--pwfile='+f.name],check=True)
"""
        run("postgres", ["/usr/local/bin/python3", "-c", command], env=ENVS["postgres"],
            data=keys["postgres"] + "\n", timeout=60)
    start("postgres", ["/usr/lib/postgresql/17/bin/postgres", "-D", "/data/postgres",
                       "-h", "127.0.0.1", "-k", "/run/dify/postgres"])
    while time.monotonic() < deadline:
        alive()
        try:
            run("postgres", ["psql", "-h", "/run/dify/postgres", "-U", "dify_postgres",
                             "-d", "postgres", "-Atc", "select 1"], env=ENVS["postgres"], timeout=3)
            break
        except subprocess.CalledProcessError:
            STOP.wait(0.25)
    else:
        raise RuntimeError("PostgreSQL connection deadline")
    if not initialized:
        sql = f"CREATE ROLE dify LOGIN PASSWORD '{keys['db']}';\nCREATE DATABASE dify OWNER dify;\nCREATE DATABASE dify_plugin OWNER dify;\n"
        run("postgres", ["psql", "-v", "ON_ERROR_STOP=1", "-h", "/run/dify/postgres",
                         "-U", "dify_postgres", "-d", "postgres"],
            env=ENVS["postgres"], data=sql, timeout=30)
        run("postgres", ["psql", "-v", "ON_ERROR_STOP=1", "-h", "/run/dify/postgres",
                         "-U", "dify_postgres", "-d", "dify", "-c", "CREATE EXTENSION vector"],
            env=ENVS["postgres"], timeout=30)


def sandbox_identity():
    """Reserve GID1000 before upstream derives its global job GID via NSS.

    Upstream useradd otherwise allocates GID2001 independently of pooled passwd
    records. Provision the inert lookup identity explicitly, not extra job caps.
    """
    try:
        group = grp.getgrnam("sandbox")
    except KeyError:
        run("sshd", ["groupadd", "-g", "1000", "sandbox"], env=ENVS["sshd"])
        group = grp.getgrnam("sandbox")
    if group.gr_gid != 1000 or group.gr_mem:
        raise RuntimeError("Sandbox GID1000 reservation mismatch")
    try:
        user = pwd.getpwnam("sandbox")
    except KeyError:
        run("sshd", ["useradd", "-M", "--no-log-init", "--no-user-group",
                     "-u", "65537", "-g", "1000", "-s", "/usr/sbin/nologin", "sandbox"],
            env=ENVS["sshd"])
        user = pwd.getpwnam("sandbox")
    if user.pw_uid != 65537 or user.pw_gid != 1000:
        raise RuntimeError("Sandbox lookup identity mismatch")


def clear_proxy_pids():
    """Clear only validated transient PID files, before this supervisor starts roles."""
    for role in ("squid", "agent_squid"):
        os.seteuid(IDS[role])
        try:
            path = Path("/run/dify") / role / (role + ".pid")
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                continue
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != IDS[role]
                    or metadata.st_nlink != 1):
                raise RuntimeError("Unsafe transient proxy PID file")
            path.unlink()
        finally:
            os.seteuid(0)


def clear_resolution_snapshots():
    """Refresh only private-template copies of Docker's three resolution files."""
    # Upstream env.sh falls back to cp across Docker bind-mount filesystems and
    # seals copies 0444. A second cp cannot overwrite them without DAC_OVERRIDE.
    # Unlink exact, validated nonsecret copies instead; retain the four-cap
    # broker policy and let upstream refresh/seal them before opening its API.
    parent = Path("/var/sandbox/sandbox-python/etc")
    if not parent.exists():
        return
    directory = parent.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0
            or directory.st_mode & 0o022):
        raise RuntimeError("Unsafe sandbox resolution template directory")
    for name in ("hosts", "hostname", "resolv.conf"):
        path = parent / name
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_nlink != 1):
            raise RuntimeError("Unsafe sandbox resolution snapshot")
        path.unlink()


# @id CODE-DIFYIMG-001 @implements REQ-DIFYIMG-001
def main():
    """Bootstrap → stores → migrations → auxiliaries → applications → readiness."""
    global ENVS, KEYS
    status = Path("/proc/self/status").read_text()
    if "NoNewPrivs:\t1" not in status:
        raise RuntimeError("no-new-privileges is required")
    if Path("/proc/sys/net/ipv4/ip_unprivileged_port_start").read_text().strip() != "0":
        raise RuntimeError("Namespace low-port sysctl must be 0")
    keys, _first = bootstrap()
    KEYS = list(keys.values())
    ENVS = {role: env_for(role) for role in IDS}
    clear_proxy_pids()
    clear_resolution_snapshots()
    # Nonsecret topology settings follow this image. Validate persisted private
    # files first; never replace/regenerate their credential material on update.
    ENVS["web"].update(web_settings())
    for role in ("api", "worker", "beat"):
        ENVS[role]["HOME"] = "/data/" + role + "-home"
    sandbox_identity()
    deadline = time.monotonic() + 300
    publish({})
    postgres(keys, deadline)
    start("redis", ["/usr/bin/redis-server", "/run/dify/redis.conf"])
    wait_role("redis", deadline)
    print("[init] Dify migration starting", flush=True)
    run("api", ["/app/api/.venv/bin/flask", "upgrade-db"],
        env=ENVS["api"], cwd="/app/api", timeout=max(1, deadline-time.monotonic()))
    print("[init] Dify migration complete", flush=True)
    run("plugin", ["/opt/plugin/commandline", "migrate"], env=ENVS["plugin"],
        cwd="/data/plugin", timeout=max(1, deadline-time.monotonic()))
    start("plugin", ["/opt/plugin/main"], "/data/plugin")
    start("sandbox", ["/usr/local/bin/python3", "/usr/local/lib/dify-image/start.py"])
    start("shell_broker", ["/usr/local/bin/python3", str(BASE / "shell_broker.py")])
    start("shellctl", ["shellctl", "serve", "--listen", "127.0.0.1:5004"], "/data/shellctl/daemon")
    start("agent", ["/opt/agent/.venv/bin/python", "-m", "uvicorn",
                    "dify_agent.server.app:app", "--host", "127.0.0.1", "--port", "5050"],
          "/opt/agent")
    for role in ("squid", "agent_squid"):
        start(role, ["/usr/sbin/squid", "-N", "-n", "dify" + role.replace("_", ""),
                     "-f", f"/run/dify/{role}.conf"])
    start("api", ["/bin/bash", "/opt/dify-image/api-entrypoint.sh"], "/app/api")
    entry = Path("/opt/dify-image/api-entrypoint.sh").read_text()
    queues = next(q for q in re.findall(r'DEFAULT_QUEUES="([^"]+)"', entry) if ",workflow," in q)
    queues = re.sub(r"\$\{[^}]+\}", "ops_trace_v2", queues)
    start("worker", ["/app/api/.venv/bin/celery", "-A", "dify_image_tasks.celery",
                     "worker", "-P", "prefork", "-c", "1", "-Q", "celery," + queues,
                     "--loglevel=WARNING"], "/app/api")
    start("beat", ["/app/api/.venv/bin/celery", "-A", "dify_image_tasks.celery", "beat",
                   "--schedule=/data/beat-home/celerybeat", "--loglevel=WARNING"], "/app/api")
    webserver = "/opt/web/web/server.js"
    if not Path(webserver).exists():
        webserver = "/opt/web/server.js"
    start("web", ["/usr/local/bin/node", webserver], str(Path(webserver).parent))
    start("nginx", ["/usr/sbin/nginx", "-c", "/run/dify/nginx.conf", "-g", "daemon off;"])
    start("sshd", ["/usr/sbin/sshd", "-D", "-e", "-f", "/run/dify/sshd.conf"])
    ready = False
    failures = 0
    while not STOP.is_set():
        alive()
        roles = {role: check(role, ENVS) for role in CHILDREN}
        publish(roles)
        if all(roles.values()):
            if not ready:
                print("[supervisor] all required roles ready", flush=True)
            ready, failures = True, 0
        elif ready:
            failures += 1
            if failures >= 2:
                raise RuntimeError("Required role became unhealthy: " +
                                   ",".join(r for r, ok in roles.items() if not ok))
        elif time.monotonic() > deadline:
            raise RuntimeError("Startup readiness deadline: " +
                               ",".join(r for r, ok in roles.items() if not ok))
        STOP.wait(5)


def shutdown():
    """Remove readiness first, then bound termination of every owned process group."""
    publish({})
    for process in reversed(list(CHILDREN.values())):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 15
    for process in CHILDREN.values():
        try:
            process.wait(timeout=max(0.01, deadline-time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)


if __name__ == "__main__":
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: STOP.set())
    code = 0
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- fail closed and redact every top-level failure
        print("[supervisor] " + redact(str(error), KEYS), flush=True)
        if isinstance(error, subprocess.CalledProcessError):
            print("[setup] " + redact((error.stderr or error.stdout or "")[-6000:], KEYS), flush=True)
        code = 1
    finally:
        if Path("/run/dify").is_dir():
            shutdown()
    raise SystemExit(code)
