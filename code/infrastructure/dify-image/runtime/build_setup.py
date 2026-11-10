"""Build-time public files only: fixed users, relocated venv and immutable jail."""
import os
import shutil
import subprocess
from pathlib import Path

from common import IDS, gid


# @id CODE-DIFYIMG-005 @implements REQ-DIFYIMG-005
def main():
    """Prepare a credential-free filesystem, including a private job template."""
    for role, uid in IDS.items():
        group = gid(role)
        name = "dev" if role == "dev" else "dify_" + role
        if subprocess.run(["getent", "group", str(group)], capture_output=True, check=False).returncode:
            subprocess.run(["groupadd", "-g", str(group), "dify_g" + str(group)], check=True)
        if subprocess.run(["getent", "passwd", str(uid)], capture_output=True, check=False).returncode:
            subprocess.run(["useradd", "-M", "-u", str(uid), "-g", str(group),
                            "-d", "/data/dev" if role == "dev" else "/nonexistent",
                            "-s", "/bin/bash" if role == "dev" else "/usr/sbin/nologin",
                            name], check=True)
    subprocess.run(["usermod", "-p", "*", "dev"], check=True)
    home_alias = Path("/home/dify")
    if home_alias.exists() or home_alias.is_symlink():
        raise RuntimeError("Unexpected upstream shell workspace")
    home_alias.symlink_to("/data/shellctl/home")
    for p in Path("/opt/agent/.venv").rglob("*.pth"):
        p.write_text(p.read_text().replace("/app/api", "/opt/agent"))
    # Executables with old venv shebangs must resolve to the relocated interpreter.
    for p in Path("/opt/agent/.venv/bin").iterdir():
        if p.is_file() and not p.is_symlink():
            content = p.read_bytes()
            if content.startswith(b"#!") and b"/app/api/.venv" in content[:200]:
                p.write_bytes(content.replace(b"/app/api/.venv", b"/opt/agent/.venv", 1))
    # Upstream public code is already readable. Recursive chmod would copy up
    # several GiB of unchanged overlay files; check root traversal instead.
    for path in ("/app/api", "/opt/agent", "/opt/web", "/opt/plugin"):
        if os.stat(path).st_mode & 0o005 != 0o005:
            raise RuntimeError("Upstream public directory is not traversable")
    # Official Node's archive retains UID1001. A four-cap root broker without
    # FOWNER cannot hardlink that read-only foreign-owned inode under Linux's
    # protected_hardlinks policy. Normalize this public executable at build time.
    os.chown("/usr/local/bin/node", 0, 0)
    root = Path("/opt/job-root")
    root.mkdir()
    # No /data, /proc, /run, SSH configuration, service venv or keys enter the jail.
    for name in ("usr/bin", "usr/lib/x86_64-linux-gnu", "usr/lib/python3.13",
                 "usr/local/bin", "usr/local/lib/python3.13", "usr/share/terminfo"):
        src, dst = Path("/") / name, root / name
        if not src.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, symlinks=True, copy_function=os.link,
                        ignore=shutil.ignore_patterns("site-packages", "node_modules"))
    for name, target in (("bin", "usr/bin"), ("lib", "usr/lib"), ("lib64", "usr/lib64")):
        (root / name).symlink_to(target)
    if Path("/usr/lib64").exists():
        shutil.copytree("/usr/lib64", root / "usr/lib64", symlinks=True, copy_function=os.link)
    for source in Path("/usr/local/lib").glob("libpython3.13.so*"):
        target = root / "usr/local/lib" / source.name
        if source.is_symlink():
            target.symlink_to(os.readlink(source))
        else:
            os.link(source, target)
    for name in ("dev", "tmp", "home/dify", "etc", "workspace"):
        (root / name).mkdir(parents=True, exist_ok=True)
    for name in ("resolv.conf", "hosts", "nsswitch.conf"):
        shutil.copyfile("/etc/" + name, root / "etc" / name)
    shutil.copytree("/etc/ssl/certs", root / "etc/ssl/certs", symlinks=True, copy_function=os.link)
    (root / "etc/passwd").write_text("job:x:10900:1000:job:/home/dify:/bin/bash\n")
    (root / "etc/group").write_text("job:x:1000:\n")
    # A regular null file is not a host device/mount; pipes/PTY FDs carry actual I/O.
    (root / "dev/null").touch(mode=0o666)
    os.chmod(root / "dev/null", 0o666)
    Path("/etc/profile.d/dify-nvm.sh").write_text(
        'export NVM_DIR=/opt/nvm\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n')


if __name__ == "__main__":
    main()
