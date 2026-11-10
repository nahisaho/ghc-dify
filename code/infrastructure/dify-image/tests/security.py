"""Real SSH/tooling and privilege-boundary qualification on the final image."""
import json
import subprocess
from pathlib import Path

import fixture


def ssh(state, command, *, user="dev", public=True, key=None):
    """Use only the generated fixture key, never the host agent or SSH config."""
    known = Path(state.get("work", fixture.WORK)) / ("known-hosts-" + state["owner"])
    args = ["ssh", "-F", "/dev/null", "-p", str(state["ssh_port"]), "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
            "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=" + str(known),
            "-i", key or state["private_key"]]
    if not public:
        args += ["-o", "PubkeyAuthentication=no",
                 "-o", "PreferredAuthentications=password,keyboard-interactive"]
    return subprocess.run([*args, user + "@127.0.0.1", command],
                          capture_output=True, text=True, timeout=30, check=False)


def tooling(state, require):
    """An authenticated nonroot development shell needs no pre-seeded Copilot auth."""
    result = ssh(state, """bash -lc 'set -e
test "$(id -u)" = 2000
test -z "$(id -Gn | tr " " "\\n" | grep -v "^dify_g2000$")"
test "$HOME" = /data/dev
test "$(nvm --version)" = 0.41.0
test "$(node --version)" = v24.22.1
test "$(npm --version)" = 11.19.1
copilot --version
test ! -e "$HOME/.config/github-copilot/apps.json"
printf "DEV_TOOLS_OK\\n"
'""")
    require(result.returncode == 0, "Public-key development SSH/tooling failed")
    require("1.0.106" in result.stdout and "DEV_TOOLS_OK" in result.stdout,
            "Pinned Copilot and tooling versions not observed")
    require(ssh(state, "true", user="root").returncode == 255, "Root SSH admitted")
    require(ssh(state, "true", public=False).returncode == 255,
            "Password/keyboard-interactive SSH admitted")
    wrong = Path(state.get("work", fixture.WORK)) / "unlisted_ed25519"
    if not wrong.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(wrong)],
                       check=True, capture_output=True)
    require(ssh(state, "true", key=str(wrong)).returncode == 255, "Unlisted SSH key admitted")


def identities(state, require):
    """Inspect actual service threads, then attempt private reads as dev."""
    code = """import json,pathlib
from common import IDS,CAPS_BROKER
services={}
for p in pathlib.Path('/proc').iterdir():
 try:
  fields=dict(l.split(':',1) for l in (p/'status').read_text().splitlines() if ':' in l)
  uid=int(fields['Uid'].split()[0])
  if uid in IDS.values() and uid not in (0,2000):
   for t in (p/'task').glob('*/status'):
    s=dict(l.split(':',1) for l in t.read_text().splitlines() if ':' in l)
    assert not s['Groups'].strip()
    assert all(int(s[k],16)==0 for k in ('CapInh','CapPrm','CapEff','CapAmb'))
    assert s['NoNewPrivs'].strip()=='1' and s['Seccomp'].strip()=='2'
   services[uid]=True
 except (OSError,ValueError):pass
print(json.dumps(sorted(services)))
"""
    observed = json.loads(fixture.execute(state, code).stdout)
    require(set(range(1101, 1113)) <= set(observed), "Missing nonroot service identity/cap0")
    denial = ssh(state, """python3 -c 'import pathlib
for p in ["/data/state/keys.json","/data/ssh/ssh_host_ed25519_key",
          "/data/secrets/api/env.json","/data/secrets/shellctl/env.json",
          "/data/secrets/redis/env.json","/data/postgres/global/pg_control"]:
 try: pathlib.Path(p).read_bytes()
 except PermissionError: continue
 raise AssertionError("development identity read runtime-private file")
print("PRIVATE_READS_DENIED")
'""")
    require(denial.returncode == 0 and "PRIVATE_READS_DENIED" in denial.stdout,
            "Development identity can read a runtime secret")


def verify(number, require):
    """Do not qualify sandbox/launcher policy until its separate checks execute."""
    if number == "005":
        from ssh_pty import verify as interactive_checks
        interactive_checks(require)
        return
    if number == "003":
        from shell_regression import verify_isolated
        verify_isolated(require)
    state = fixture.get()
    if number == "003":
        from shell_regression import verify_restart
        verify_restart(state, require)
    tooling(state, require)
    if number == "003":
        identities(state, require)
        from jobs import verify as job_checks
        job_checks(state, require)
        from secrets_checks import verify as secret_checks
        secret_checks(state, require)
