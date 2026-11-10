"""Atomic, fail-closed persisted runtime credential and data initialization."""
import hashlib
import json
import os
import secrets
import stat
import subprocess
from pathlib import Path

from common import DATA, IDS, gid, read_as
from configure import configs, environments


def directory(path, uid=0, group=0, mode=0o700):
    """Create only expected directories; never follow a persisted symlink."""
    p = Path(path)
    parent = p.parent.stat()
    os.setegid(parent.st_gid)
    os.seteuid(parent.st_uid)
    try:
        if p.exists() or p.is_symlink():
            s = p.lstat()
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != uid or stat.S_IMODE(s.st_mode) != mode:
                raise RuntimeError("Persisted directory policy mismatch")
            return p
        p.mkdir(mode=mode)
        os.chmod(p, mode)
        os.chown(p, uid, group)
        return p
    finally:
        os.seteuid(0)
        os.setegid(0)


def write(path, content, uid=0, group=0):
    """Write a new private file without following links or replacing old data."""
    os.setegid(group)
    os.seteuid(uid)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
    finally:
        os.seteuid(0)
        os.setegid(0)


def private(path, uid):
    """Validate metadata before any content is read under the expected owner."""
    os.seteuid(uid)
    try:
        s = Path(path).lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid != uid or stat.S_IMODE(s.st_mode) != 0o600 or s.st_nlink != 1:
            raise RuntimeError("Persisted key policy mismatch")
    finally:
        os.seteuid(0)


# @id CODE-DIFYIMG-002 @implements REQ-DIFYIMG-002
def bootstrap():
    """Initialize an empty volume once; never repair or rotate existing secrets."""
    os.umask(0o077)
    if DATA.is_symlink() or not DATA.is_dir():
        raise RuntimeError("A real persistent /data directory is required")
    marker = DATA / ".initialized.json"
    first = not marker.exists()
    if first and any(DATA.iterdir()):
        raise RuntimeError("Partial data without initialization marker")
    if first:
        write(DATA / ".initializing", "1")
        directory(DATA / "state")
        keys = {k: secrets.token_urlsafe(32) for k in
                ("api", "db", "postgres", "redis", "plugin", "inner",
                 "sandbox", "agent", "agent_server", "shellctl")}
        write(DATA / "state/keys.json", json.dumps(keys))
        directory(DATA / "secrets", mode=0o755)
        envs = environments(keys)
        manifest = {}
        for role, env in envs.items():
            path = directory(DATA / "secrets" / role, IDS[role], gid(role))
            content = json.dumps(env, sort_keys=True)
            write(path / "env.json", content, IDS[role], gid(role))
            manifest[f"secrets/{role}/env.json"] = {
                "owner": role, "sha256": hashlib.sha256(content.encode()).hexdigest()}
        directory(DATA / "ssh")
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "",
                        "-f", str(DATA / "ssh/ssh_host_ed25519_key")],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for p in (DATA / "ssh").iterdir():
            os.chmod(p, 0o600)
            manifest[str(p.relative_to(DATA))] = {
                "owner": "sshd", "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        manifest["state/keys.json"] = {
            "owner": "sshd", "sha256": hashlib.sha256((DATA / "state/keys.json").read_bytes()).hexdigest()}
        # Persistent non-secret service data has separate fixed owners.
        for role in ("postgres", "redis", "plugin", "dev"):
            directory(DATA / role, IDS[role], gid(role))
        directory(DATA / "shellctl", 0, gid("shellctl"), 0o750)
        for role in ("api", "worker", "beat"):
            directory(DATA / (role + "-home"), IDS[role], gid(role))
        directory(DATA / "storage", IDS["api"], 1200, 0o770)
        directory(DATA / "shellctl/home", IDS["shellctl"], gid("shellctl"))
        directory(DATA / "shellctl/daemon", IDS["shellctl"], gid("shellctl"))
        directory(DATA / "shellctl/state", IDS["shellctl"], gid("shellctl"))
        directory(DATA / "plugin/cwd", IDS["plugin"], gid("plugin"))
        profile = 'export NVM_DIR=/opt/nvm\n. "$NVM_DIR/nvm.sh"\n'
        write(DATA / "dev/.bash_profile", profile, IDS["dev"], gid("dev"))
        write(DATA / "dev/.bashrc", profile, IDS["dev"], gid("dev"))
        write(DATA / ".initialized.tmp", json.dumps({"schema": 1, "files": manifest}))
        os.rename(DATA / ".initialized.tmp", marker)
        fd = os.open(DATA, os.O_DIRECTORY)
        os.fsync(fd)
        os.close(fd)
        (DATA / ".initializing").unlink()
    private(marker, 0)
    if (DATA / ".initializing").exists():
        raise RuntimeError("Interrupted initialization")
    directory(DATA / "state")
    private(DATA / "state/keys.json", 0)
    keys = json.loads((DATA / "state/keys.json").read_text())
    if set(keys) != {"api", "db", "postgres", "redis", "plugin", "inner", "sandbox",
                     "agent", "agent_server", "shellctl"} or any(
                         not isinstance(v, str) or len(v) != 43 for v in keys.values()):
        raise RuntimeError("Invalid runtime key material")
    manifest = json.loads(marker.read_text())
    expected = {f"secrets/{r}/env.json" for r in IDS} | {
        "state/keys.json", "ssh/ssh_host_ed25519_key", "ssh/ssh_host_ed25519_key.pub"}
    if manifest.get("schema") != 1 or set(manifest.get("files", {})) != expected:
        raise RuntimeError("Invalid initialization manifest")
    for role in IDS:
        directory(DATA / "secrets" / role, IDS[role], gid(role))
    for name, item in manifest["files"].items():
        role = item["owner"]
        private(DATA / name, IDS[role])
        content = read_as(DATA / name, role).encode()
        if hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise RuntimeError("Persisted key integrity failure")
    configs(keys)
    # Public-key authentication has no fallback to baked-in or host credentials.
    source = Path("/run/authorized_keys")
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 65536:
        raise RuntimeError("Invalid authorized_keys mount")
    public = source.read_text()
    lines = [line for line in public.splitlines() if line.strip() and not line.startswith("#")]
    if not lines or any(not line.startswith(("ssh-ed25519 ", "ssh-rsa ", "ecdsa-sha2-")) for line in lines):
        raise RuntimeError("Only ordinary authorized public keys are accepted")
    subprocess.run(["ssh-keygen", "-l", "-f", str(source)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target = Path("/run/dify/authorized_keys")
    if target.exists() or target.is_symlink():
        metadata = target.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) not in (0o600, 0o644):
            raise RuntimeError("Invalid transient public authorization file")
        target.unlink()
    write(target, public)
    # sshd reads this PUBLIC file under dev's identity. Root ownership and no
    # write permission for dev preserve StrictModes; host private keys stay0600.
    target.chmod(0o644)
    for role in ("nginx", "squid", "agent_squid", "postgres"):
        p = Path("/run/dify") / role
        p.mkdir(mode=0o700, exist_ok=True)
        os.chown(p, IDS[role], gid(role))
    os.chmod("/run/dify/nginx.conf", 0o600)
    os.chown("/run/dify/nginx.conf", IDS["nginx"], gid("nginx"))
    return keys, first
