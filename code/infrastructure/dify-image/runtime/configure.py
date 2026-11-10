"""Pinned upstream defaults with explicit local, secret-free-at-build overrides."""
import os
import re
import stat
from pathlib import Path

from common import IDS, gid


def defaults():
    """Resolve upstream ${VAR:-default} expressions, including nested defaults."""
    values = {}

    def expand(value):
        for _ in range(100):
            start = value.rfind("${")
            if start < 0:
                return value
            depth, end = 1, start + 2
            while end < len(value) and depth:
                depth += (value[end] == "{") - (value[end] == "}")
                end += 1
            if depth:
                raise RuntimeError("Unclosed upstream default expression")
            match = re.fullmatch(r"([A-Z0-9_]+)(?:(:-|-)(.*))?", value[start + 2:end - 1])
            if not match:
                raise RuntimeError("Unsupported upstream default expression")
            name, operator, fallback = match.groups()
            replacement = (values.get(name) or fallback or "") if operator == ":-" else values.get(name, fallback or "")
            value = value[:start] + replacement + value[end:]
        raise RuntimeError("Recursive upstream default expression")

    paths = ["core-services/shared", "core-services/api-worker",
             "databases/db-postgres", "databases/redis",
             "core-services/web", "core-services/sandbox",
             "core-services/plugin-daemon", "core-services/dify-agent"]
    for name in paths:
        p = Path("/opt/upstream/docker/envs") / (name + ".defaults")
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                value = expand(value)
                values[key] = value.strip("'\"")
    return values


def web_settings():
    """Keep browser-relative URLs distinct from the server-only loopback origin."""
    return {"CONSOLE_API_URL": "", "APP_API_URL": "",
            "SERVER_CONSOLE_API_URL": "http://127.0.0.1:5001",
            "NEXT_PUBLIC_API_PREFIX": "/console/api", "NEXT_PUBLIC_PUBLIC_API_PREFIX": "/api",
            "NEXT_PUBLIC_MARKETPLACE_API_PREFIX": "https://marketplace.dify.ai/api/v1",
            "NEXT_PUBLIC_MARKETPLACE_URL_PREFIX": "https://marketplace.dify.ai"}


def environments(keys):
    """Separate process environments; a role receives only credentials it uses."""
    base = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
            "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    api = defaults()
    # Do not leak plugin/agent aliases from combined upstream templates.
    api = {k: v for k, v in api.items() if not any(s in k for s in ("SECRET", "PASSWORD", "TOKEN", "KEY"))}
    api.update(base, SECRET_KEY=keys["api"], DB_TYPE="postgresql", DB_HOST="127.0.0.1",
               DB_PORT="5432", DB_USERNAME="dify", DB_PASSWORD=keys["db"], DB_DATABASE="dify",
               REDIS_HOST="127.0.0.1", REDIS_PORT="6379", REDIS_PASSWORD=keys["redis"],
               REDIS_DB="0", CELERY_BROKER_URL=f"redis://:{keys['redis']}@127.0.0.1:6379/1",
               VECTOR_STORE="pgvector", PGVECTOR_HOST="127.0.0.1", PGVECTOR_PORT="5432",
               PGVECTOR_USER="dify", PGVECTOR_PASSWORD=keys["db"], PGVECTOR_DATABASE="dify",
               PGVECTOR_MIN_CONNECTION="1", PGVECTOR_MAX_CONNECTION="5",
               STORAGE_TYPE="opendal", OPENDAL_SCHEME="fs", OPENDAL_FS_ROOT="/data/storage",
               DIFY_BIND_ADDRESS="127.0.0.1", DIFY_PORT="5001", MIGRATION_ENABLED="false",
               PLUGIN_DAEMON_URL="http://127.0.0.1:5002", PLUGIN_DAEMON_KEY=keys["plugin"],
               INNER_API_KEY_FOR_PLUGIN=keys["inner"], CODE_EXECUTION_ENDPOINT="http://127.0.0.1:8194",
               CODE_EXECUTION_API_KEY=keys["sandbox"], SSRF_PROXY_HTTP_URL="http://127.0.0.1:3128",
               SSRF_PROXY_HTTPS_URL="http://127.0.0.1:3128",
               HTTP_PROXY="http://127.0.0.1:3128", HTTPS_PROXY="http://127.0.0.1:3128",
               SANDBOX_HTTP_PROXY="http://127.0.0.1:3128", SANDBOX_HTTPS_PROXY="http://127.0.0.1:3128",
               NO_PROXY="127.0.0.1,localhost,::1", AGENT_BACKEND_BASE_URL="http://127.0.0.1:5050",
               DIFY_AGENT_API_TOKEN=keys["agent"], CONSOLE_WEB_URL="http://localhost:8080",
               CONSOLE_API_URL="", SERVICE_API_URL="", APP_WEB_URL="", APP_API_URL="",
               FILES_URL="http://localhost:8080", INTERNAL_FILES_URL="http://127.0.0.1:5001",
               PATH="/app/api/.venv/bin:" + base["PATH"], PYTHONPATH="/opt/dify-image/runtime:/app/api",
               CELERY_WORKER_POOL="prefork", CELERY_WORKER_CONCURRENCY="1",
               SERVER_WORKER_CLASS="gthread", SERVER_WORKER_AMOUNT="1", LOG_LEVEL="WARNING",
               DEBUG="false", LOG_FILE="", FLASK_APP="app", HOME="/data/api-home")
    envs = {role: dict(base, HOME="/nonexistent") for role in IDS}
    for role in ("api", "worker", "beat"):
        envs[role] = dict(api, MODE=role)
    envs["postgres"].update(PGDATA="/data/postgres")
    envs["redis"].update(REDISCLI_AUTH=keys["redis"])
    envs["web"].update(PORT="3000", HOSTNAME="127.0.0.1", NODE_ENV="production",
                       NEXT_TELEMETRY_DISABLED="1", NODE_PATH="/opt/sharp/node_modules",
                       **web_settings(),
                       NEXT_PUBLIC_DEPLOY_ENV="PRODUCTION", DEPLOY_ENV="PRODUCTION")
    envs["plugin"].update(DB_TYPE="postgresql", DB_HOST="127.0.0.1", DB_PORT="5432",
                          DB_USERNAME="dify", DB_PASSWORD=keys["db"], DB_DATABASE="dify_plugin",
                          DB_SSL_MODE="disable", REDIS_HOST="127.0.0.1", REDIS_PORT="6379",
                          REDIS_PASSWORD=keys["redis"], SERVER_PORT="5002", SERVER_KEY=keys["plugin"],
                          DIFY_INNER_API_URL="http://127.0.0.1:5001", DIFY_INNER_API_KEY=keys["inner"],
                          PLATFORM="local", STORAGE_TYPE="local", STORAGE_LOCAL_ROOT="/data/plugin",
                          PLUGIN_WORKING_PATH="/data/plugin/cwd", PLUGIN_INSTALLED_PATH="plugin",
                          PLUGIN_PACKAGE_CACHE_PATH="plugin_packages", PLUGIN_MEDIA_CACHE_PATH="assets",
                          FORCE_VERIFYING_SIGNATURE="true", PYTHON_ENV_INIT_TIMEOUT="120",
                          PLUGIN_REMOTE_INSTALLING_ENABLED="false",
                          PLUGIN_REMOTE_INSTALLING_HOST="127.0.0.1",
                          PLUGIN_REMOTE_INSTALLING_PORT="5003", SERVER_HOST="127.0.0.1",
                          HOME="/data/plugin",
                          PYTHON_INTERPRETER_PATH="/usr/local/bin/python3")
    envs["agent"].update(PATH="/opt/agent/.venv/bin:" + base["PATH"], PYTHONPATH="/opt/agent",
                         DIFY_AGENT_API_TOKEN=keys["agent"],
                         DIFY_AGENT_SERVER_SECRET_KEY=keys["agent_server"],
                         DIFY_AGENT_REDIS_URL=f"redis://:{keys['redis']}@127.0.0.1:6379/2",
                         DIFY_AGENT_PLUGIN_DAEMON_URL="http://127.0.0.1:5002",
                         DIFY_AGENT_PLUGIN_DAEMON_API_KEY=keys["plugin"],
                         DIFY_AGENT_INNER_API_URL="http://127.0.0.1:5001",
                         DIFY_AGENT_INNER_API_KEY=keys["inner"], DIFY_AGENT_RUNTIME_BACKEND="local",
                         DIFY_AGENT_LOCAL_SANDBOX_ENDPOINT="http://127.0.0.1:5004",
                         DIFY_AGENT_LOCAL_SANDBOX_AUTH_TOKEN=keys["shellctl"],
                         DIFY_AGENT_STUB_API_BASE_URL="http://127.0.0.1:5050/agent-stub",
                         DIFY_AGENT_SANDBOX_FILES_BASE_URL="http://127.0.0.1:5001")
    envs["shellctl"].update(HOME="/data/shellctl/daemon", SHELL="/bin/bash",
                            XDG_DATA_HOME="/data/shellctl/state",
                            SHELLCTL_AUTH_TOKEN=keys["shellctl"], SHELLCTL_ENABLE_PATH_ISOLATION="true")
    envs["sandbox"].update(API_KEY=keys["sandbox"], PYTHON_PATH="/opt/python/bin/python3",
                           NODEJS_PATH="/opt/dify-sandbox/node-v20.20.0-linux-x64/bin/node",
                           ENABLE_PRELOAD="false", WORKER_TIMEOUT="15", DEBUG="false")
    return envs


# @id CODE-DIFYIMG-004 @implements REQ-DIFYIMG-004
def configs(keys):
    """Render fixed SSH and proxy policies without credential-bearing URL logs."""
    p = Path("/run/dify")
    p.mkdir(mode=0o755, exist_ok=True)
    p.chmod(0o755)
    for name in ("sshd", "nginx", "squid", "agent_squid", "redis"):
        previous = p / (name + ".conf")
        if previous.exists() or previous.is_symlink():
            metadata = previous.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in (0, IDS[name]) or metadata.st_nlink != 1:
                raise RuntimeError("Invalid transient role configuration")
            previous.unlink()
    (p / "sshd.conf").write_text("""Port 22
ListenAddress 0.0.0.0
HostKey /data/ssh/ssh_host_ed25519_key
PidFile /run/sshd.pid
AllowUsers dev
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PubkeyAuthentication yes
AuthorizedKeysFile /run/dify/authorized_keys
StrictModes yes
UsePAM no
PrintMotd no
Subsystem sftp internal-sftp
LogLevel ERROR
""")
    (p / "nginx.conf").write_text("""pid /run/dify/nginx/nginx.pid;
error_log stderr error;
events { worker_connections 128; }
http {
 access_log off; client_max_body_size 100m;
 client_body_temp_path /run/dify/nginx/body;
 proxy_temp_path /run/dify/nginx/proxy;
 fastcgi_temp_path /run/dify/nginx/fastcgi;
 uwsgi_temp_path /run/dify/nginx/uwsgi;
 scgi_temp_path /run/dify/nginx/scgi;
 server { listen 80; proxy_buffering off; proxy_read_timeout 600s;
 location /console/api { proxy_pass http://127.0.0.1:5001; }
 location /api { proxy_pass http://127.0.0.1:5001; }
 location /v1 { proxy_pass http://127.0.0.1:5001; }
 location /files { proxy_pass http://127.0.0.1:5001; }
 location /mcp { proxy_pass http://127.0.0.1:5001; }
 location /health { proxy_pass http://127.0.0.1:5001; }
 location / { proxy_pass http://127.0.0.1:3000; }
 }}
""")
    for role, port in (("squid", 3128), ("agent_squid", 3129)):
        text = f"""http_port 127.0.0.1:{port}
shutdown_lifetime 1 seconds
pid_filename /run/dify/{role}/{role}.pid
access_log none
cache_log /run/dify/{role}/cache.log
cache_store_log none
cache deny all
cache_mem 8 MB
memory_cache_shared off
pinger_enable off
coredump_dir /run/dify/{role}
acl localnet dst 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 ::1/128
acl SSL_ports port 443
acl Safe_ports port 80 443
acl CONNECT method CONNECT
"""
        if role == "agent_squid":
            text += "acl agent dst 127.0.0.1\nacl agentports port 5001 5050\nacl agentpaths urlpath_regex ^/agent-stub/ ^/files/\nhttp_access allow agent agentports agentpaths\n"
        text += "http_access deny !Safe_ports\nhttp_access deny CONNECT !SSL_ports\nhttp_access deny localnet\nhttp_access allow all\n"
        (p / f"{role}.conf").write_text(text)
        os.chmod(p / f"{role}.conf", 0o600)
        os.chown(p / f"{role}.conf", IDS[role], gid(role))
    (p / "redis.conf").write_text("bind 127.0.0.1\nport 6379\nprotected-mode yes\n"
                                f"requirepass {keys['redis']}\ndir /data/redis\nappendonly yes\n")
    os.chmod(p / "redis.conf", 0o600)
    os.chown(p / "redis.conf", IDS["redis"], gid("redis"))
