"""Owned SSH-only qualification: no user keys, live ports, data or container."""
import contextlib
import json
import socket
import subprocess
import time
import uuid
from pathlib import Path

import fixture

START = """import os
from bootstrap import bootstrap
bootstrap()
os.execv('/usr/sbin/sshd',['/usr/sbin/sshd','-D','-e','-f','/run/dify/sshd.conf',
 '-o','LogLevel=DEBUG3'])
"""


def docker(args, *, timeout=30, check=True):
    """Capacity-check each bounded operation; stderr never contains user secrets."""
    fixture.guard.capacity()
    return subprocess.run(["docker", *args], capture_output=True, text=True,
                          timeout=timeout, check=check)


@contextlib.contextmanager
def owned_ssh(*, caps=None, image=None, key_type="ed25519"):
    """Generate disposable keys and bind SSH to an ephemeral loopback-only port."""
    owner = "ssh-pty-" + uuid.uuid4().hex
    work = fixture.WORK.parent / owner
    work.mkdir(mode=0o700)
    private = work / "synthetic_key"
    cid = None
    try:
        args = ["ssh-keygen", "-q", "-t", key_type, "-N", "", "-f", str(private)]
        if key_type == "rsa":
            args += ["-b", "3072"]
        subprocess.run(args, check=True, capture_output=True, timeout=30)
        if caps is None:
            argv = fixture.guard.run_args(fixture.guard.IMAGE, str(private) + ".pub",
                                         "unused-ssh-probe", owner)
            caps = {argv[i + 1] for i, value in enumerate(argv) if value == "--cap-add"}
        cid = docker([
            "create", "--pull=never", "--no-healthcheck",
            "--label", fixture.guard.LABEL + "=" + owner,
            "--name", "okayama-u-" + owner, "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--sysctl=net.ipv4.ip_unprivileged_port_start=0",
            "--pids-limit=128", "--memory=256m",
            "--publish", "127.0.0.1::22",
            "--mount", f"type=bind,source={private}.pub,target=/run/authorized_keys,readonly",
            *[value for cap in sorted(caps) for value in ("--cap-add", cap)],
            "--entrypoint=/usr/local/bin/python3", image or fixture.guard.IMAGE,
            "-c", START,
        ]).stdout.strip()
        docker(["start", cid])
        inspected = json.loads(docker(["inspect", cid]).stdout)[0]
        if not inspected["State"]["Running"]:
            output = docker(["logs", cid])
            raise AssertionError("Owned SSH-only startup: " + (output.stdout + output.stderr)[-1500:])
        port = int(inspected["NetworkSettings"]["Ports"]["22/tcp"][0]["HostPort"])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1) as connection:
                    if connection.recv(1024).startswith(b"SSH-"):
                        break
            except OSError:
                pass
            time.sleep(0.05)
        else:
            raise AssertionError("Owned SSH-only fixture never listened")
        yield {"container": cid, "owner": owner, "private_key": str(private),
               "ssh_port": port, "work": str(work), "caps": sorted(caps)}
    finally:
        if cid:
            obj = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True,
                                                     timeout=15))[0]
            assert obj["Config"]["Labels"].get(fixture.guard.LABEL) == owner
            subprocess.run(["docker", "rm", "--force", cid], capture_output=True,
                           timeout=30, check=True)
        for path in work.iterdir():
            assert path.is_file() and not path.is_symlink()
            path.unlink()
        work.rmdir()


def connect(state, *, tty, command=None, data=None, user="dev"):
    """Never use the host SSH config, agent, private key or passphrase."""
    args = ["ssh", "-F", "/dev/null", "-tt" if tty else "-T",
            "-p", str(state["ssh_port"]), "-o", "BatchMode=yes",
            "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes",
            "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=" + str(Path(state["work"]) / "known_hosts"),
            "-i", state["private_key"], user + "@127.0.0.1"]
    if command is not None:
        args.append(command)
    return subprocess.run(args, input=data, text=True, capture_output=True,
                          timeout=20, check=False)


def probe(state):
    """Compare a command-only session, forced PTY and a real login shell."""
    command = """test "$(id -u)" = 2000 &&
python3 -c 'import sys; assert sys.version_info.major == 3' &&
test "$(node --version)" = v24.22.1 && test "$(npm --version)" = 11.19.1 &&
copilot --version && printf STDIO_OK"""
    plain = connect(state, tty=False, command=command)
    terminal = connect(state, tty=True, command="""test -t 0 && test -t 1 &&
test "$(id -u)" = 2000 && stty size && printf TTY_OK""")
    login = connect(state, tty=True, data="""test -t 0 && test -t 1 || exit 73
test "$(id -u)" = 2000 || exit 74
test "$(nvm --version)" = 0.41.0 || exit 75
python3 -c 'from pathlib import Path; s=dict(l.split(":",1) for l in Path("/proc/self/status").read_text().splitlines() if ":" in l); assert all(int(s[k],16)==0 for k in ("CapInh","CapPrm","CapEff","CapAmb")); assert s["NoNewPrivs"].strip()=="1"'
test "$?" = 0 || exit 76
printf 'PTY_%s\\n' 'LOGIN_OK'
exit
""")
    logs = docker(["logs", state["container"]]).stderr
    evidence = [line for line in logs.splitlines() if
                any(word in line.lower() for word in
                    ("fatal", "chmod", "chown", "permitted", "openpty", "pty", "tty", "session", "failed"))]
    return {"caps": state["caps"], "stdio": plain.returncode == 0 and "STDIO_OK" in plain.stdout,
            "tty": terminal.returncode == 0 and "TTY_OK" in terminal.stdout,
            "login": login.returncode == 0 and "PTY_LOGIN_OK" in login.stdout,
            "exitCodes": [plain.returncode, terminal.returncode, login.returncode],
            "diagnosis": evidence, "ttyClient": terminal.stderr[-1500:],
            "loginClient": login.stderr[-1500:]}


def verify(require):
    """The production-default capability set must admit real login PTYs."""
    from security import tooling
    with owned_ssh() as state:
        result = probe(state)
        require(result["stdio"], "Non-PTY development SSH failed")
        require(result["tty"], "Authenticated development SSH PTY was closed")
        require(result["login"], "Interactive login shell or cap0/profile failed")
        tooling(state, require)


if __name__ == "__main__":
    ceiling = {"CHOWN", "SETUID", "SETGID", "KILL", "SYS_CHROOT"}
    for caps in (ceiling, ceiling | {"FOWNER"}):
        with owned_ssh(caps=caps) as state:
            print(json.dumps(probe(state)), flush=True)
