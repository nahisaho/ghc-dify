"""Owned-volume recreation and restored, real bootstrap corruption controls."""
import json
import subprocess
import sys
import uuid

import fixture
from native import Console
from security import ssh

SNAPSHOT = """import hashlib,json,os,stat,base64
from pathlib import Path
from common import IDS,read_as
marker=json.loads(Path('/data/.initialized.json').read_text())
result={}
for name,item in marker['files'].items():
 uid=IDS[item['owner']];os.seteuid(uid)
 try:
  p=Path('/data')/name;s=p.stat()
  assert s.st_uid==uid and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1
  assert stat.S_IMODE(p.parent.stat().st_mode)==0o700
  result[name]=hashlib.sha256(p.read_bytes()).hexdigest()
 finally:os.seteuid(0)
keys=json.loads(Path('/data/state/keys.json').read_text())
assert len(set(keys.values()))==10
assert all(len(base64.urlsafe_b64decode(v+'='))>=32 for v in keys.values())
print(json.dumps(result))
"""

CORRUPTION = """import json,os,stat
from pathlib import Path
from bootstrap import bootstrap
from common import IDS,read_as
marker=json.loads(Path('/data/.initialized.json').read_text())
items=dict(marker['files'])
items['.initialized.json']={'owner':'sshd'}
count=0
def snapshot():
 return {n:read_as(Path('/data')/n,m['owner']) for n,m in items.items()}
original=snapshot()
for name,item in items.items():
 p=Path('/data')/name;uid=IDS[item['owner']]
 for mutation in ('delete','truncate','symlink','misown','widen'):
  os.seteuid(uid);fd=os.open(p,os.O_RDWR);saved=os.fstat(fd)
  try:
   if mutation=='delete':p.unlink()
   elif mutation=='truncate':os.ftruncate(fd,0)
   elif mutation=='symlink':p.unlink();p.symlink_to('/dev/null')
   elif mutation=='widen':os.fchmod(fd,0o644)
   else:
    os.seteuid(0);os.fchown(fd,3000,saved.st_gid)
   os.seteuid(0)
   rejected=False
   try:bootstrap()
   except (RuntimeError,OSError,ValueError,KeyError):rejected=True
   assert rejected,'corrupt persisted credential was accepted'
   # No production self-repair: all unmutated keys must be byte-identical.
   for other,metadata in items.items():
    if other!=name:assert read_as(Path('/data')/other,metadata['owner'])==original[other]
   # Root deliberately lacks DAC bypass: inspect a deleted/symlinked entry
   # under the directory's owner, not root outside its private0700 directory.
   os.seteuid(uid)
   if mutation=='delete':assert not p.exists()
   if mutation=='truncate':assert os.fstat(fd).st_size==0
   if mutation=='symlink':assert p.is_symlink()
   if mutation=='misown':assert os.fstat(fd).st_uid==3000
   if mutation=='widen':assert stat.S_IMODE(os.fstat(fd).st_mode)==0o644
   os.seteuid(0)
   count+=1
  finally:
   os.seteuid(0)
   os.fchown(fd,saved.st_uid,saved.st_gid)
   os.seteuid(uid)
   if mutation in ('delete','symlink'):
    if p.is_symlink():p.unlink()
    replacement=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.write(replacement,original[name].encode());os.close(replacement)
    os.seteuid(0)
    # Open under the owner, then restore its primary group without DAC override.
    os.seteuid(uid);replacement=os.open(p,os.O_RDONLY);os.seteuid(0)
    os.fchown(replacement,saved.st_uid,saved.st_gid);os.close(replacement)
   else:
    os.ftruncate(fd,0);os.write(fd,original[name].encode());os.fchmod(fd,0o600)
   os.close(fd);os.seteuid(0)
assert snapshot()==original
print(json.dumps({'rejected':count,'restored':True}))
"""


def isolated(state, code, volume=None):
    """Same final image, exact owned data/public-key mounts, no network/host access."""
    data_volume = volume or state["volume"]
    info = json.loads(fixture.docker(["volume", "inspect", data_volume]).stdout)[0]
    assert info.get("Labels", {}).get(fixture.guard.LABEL) == state["owner"]
    args = ["create", "--pull=never", "--network=none", "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true", "--label",
            fixture.guard.LABEL + "=" + state["owner"],
            "--mount", "type=volume,source=" + data_volume + ",target=/data",
            "--mount", "type=bind,source=" + state["public_key"] + ",target=/run/authorized_keys,readonly"]
    for cap in ("CHOWN", "SETUID", "SETGID", "SYS_CHROOT"):
        args += ["--cap-add", cap]
    cid = fixture.docker([*args, "--entrypoint=/usr/local/bin/python3",
                          state["image"], "-c", code]).stdout.strip()
    try:
        return fixture.docker(["start", "--attach", cid], timeout=180)
    finally:
        obj = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
        assert obj["Config"]["Labels"].get(fixture.guard.LABEL) == state["owner"]
        subprocess.run(["docker", "rm", "--force", cid], check=True,
                       capture_output=True, timeout=30)


def recreate(state):
    """Replace only the container, retaining its exact owned volume."""
    fixture.owned(state)
    fixture.docker(["stop", "--time", "20", state["container"]], timeout=60)
    fixture.docker(["rm", state["container"]])
    fixture.launch(state)
    fixture.ready(state)


def stale_proxy_pids(state):
    """Freeze exact owned proxy PIDs and leave authentic per-owner crash files."""
    assert fixture.owned(state)["State"]["Running"]
    code = """import json,os,signal
from pathlib import Path
from common import IDS
pids=json.loads(Path('/run/dify/readiness.json').read_text())['pids']
for role in ('squid','agent_squid'):
 pid=pids[role]
 status=dict(line.split(':',1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
 assert int(status['Uid'].split()[0])==IDS[role]
 os.kill(pid,signal.SIGSTOP)
 os.seteuid(IDS[role])
 try:
  path=Path('/run/dify')/role/(role+'.pid')
  assert path.stat().st_uid==IDS[role]
  path.write_text('1\\n')
 finally:os.seteuid(0)
print('OWNED_CRASH_PID_FILES_INJECTED')
"""
    assert fixture.execute(state, code).stdout.strip() == "OWNED_CRASH_PID_FILES_INJECTED"


def verify(require):
    """Never use real Copilot credentials for persistence qualification."""
    state = fixture.get()
    print("persistence: healthy baseline", file=sys.stderr, flush=True)
    before = json.loads(fixture.execute(state, SNAPSHOT).stdout)
    client = Console(state)
    status, response = client.request("/console/api/workspaces")
    workspaces = sorted((w["id"], w["name"]) for w in response.get("workspaces", []))
    require(status == 200 and bool(workspaces), "Native workspace control unavailable")
    from jobs import call
    shell = call(state, "shellctl", {"script": "printf shell-persisted > qualification-shell",
                 "cwd": "/data/shellctl/home", "mode": "stdio"})
    require(shell["http"] == 200 and shell["body"].get("exit_code") == 0,
            "Native job workspace persistence control failed")
    require(ssh(state, "mkdir -p ~/.copilot; printf synthetic-auth-sentinel "
                "> ~/.copilot/qualification-sentinel").returncode == 0,
            "Development home persistence control could not be written")
    fixture.execute(state, """from common import run,env_for
from pathlib import Path
run('postgres',['psql','-h','/run/dify/postgres','-U','dify_postgres','-d','dify','-c',
 'CREATE TABLE IF NOT EXISTS image_persistence (value text);'
 'TRUNCATE image_persistence; INSERT INTO image_persistence VALUES (\\'persisted\\')'],
 env=env_for('postgres'))
run('redis',['redis-cli','--no-auth-warning','SET','image:persistence','persisted'],env=env_for('redis'))
""")
    fixture.execute(state, "from pathlib import Path;Path('/data/storage/qualification').write_text('persisted')",
                    user="1101:1200")
    recreate(state)
    print("persistence: recreated and healthy", file=sys.stderr, flush=True)
    require(json.loads(fixture.execute(state, SNAPSHOT).stdout) == before,
            "Recreation changed runtime keys or SSH fingerprint")
    require(ssh(state, "test \"$(cat ~/.copilot/qualification-sentinel)\" = synthetic-auth-sentinel").returncode == 0,
            "Dedicated Copilot home or SSH host identity did not persist")
    fixture.execute(state, """from common import run,env_for
assert run('postgres',['psql','-h','/run/dify/postgres','-U','dify_postgres','-d','dify',
 '-Atc','SELECT value FROM image_persistence'],env=env_for('postgres')).stdout.strip()=='persisted'
assert run('redis',['redis-cli','--no-auth-warning','GET','image:persistence'],
 env=env_for('redis')).stdout.strip()=='persisted'
""")
    require(fixture.execute(state, "from pathlib import Path;assert Path('/data/storage/qualification').read_text()=='persisted'",
                            user="1101:1200").returncode == 0, "API storage persistence failed")
    restored_workspaces = Console(state).request("/console/api/workspaces")[1]
    require(sorted((w["id"], w["name"]) for w in restored_workspaces.get("workspaces", [])) == workspaces,
            "Native account/workspace did not persist")
    shell = call(state, "shellctl", {"script": "cat qualification-shell",
                 "cwd": "/data/shellctl/home", "mode": "stdio"})
    require(shell["http"] == 200 and shell["body"].get("exit_code") == 0 and
            shell["body"].get("output", shell["body"].get("stdout", "")).strip() == "shell-persisted",
            "Native execution workspace did not survive recreation")
    print("persistence: data and dev-home preserved; stopping for corruptions", file=sys.stderr, flush=True)
    # Docker cp from stdin remaps owner to root even with --archive; such a file
    # correctly fails closed. Freeze real owners instead, then bounded shutdown
    # kills them and leaves exactly the authentic stale files we need to test.
    stale_proxy_pids(state)
    fixture.docker(["stop", "--time", "20", state["container"]], timeout=60)
    try:
        result = json.loads(isolated(state, CORRUPTION).stdout)
        require(result["restored"] and result["rejected"] >= 100,
                "Not every credential class and corruption mechanism was rejected")
        print("persistence: all credential corruptions rejected and restored", file=sys.stderr, flush=True)
    finally:
        fixture.docker(["start", state["container"]])
        fixture.ready(state)
    recovered = """import json
from pathlib import Path
from common import read_as
pids=json.loads(Path('/run/dify/readiness.json').read_text())['pids']
for role in ('squid','agent_squid'):
 assert int(read_as(Path('/run/dify')/role/(role+'.pid'),role))==pids[role]
print('STALE_PROXY_PID_RECOVERY_OK')
"""
    require(fixture.execute(state, recovered).stdout.strip() == "STALE_PROXY_PID_RECOVERY_OK",
            "Same-container restart did not recover exact stale proxy PID collisions")
    # A second genuinely fresh full stack proves unseeded setup and distinct keys.
    volume = "okayama-u-dify-fresh-" + uuid.uuid4().hex[:12]
    fixture.docker(["volume", "create", "--label", fixture.guard.LABEL + "=" + state["owner"], volume])
    fresh_state = dict(state, volume=volume)
    launched = False
    try:
        interrupted = """from pathlib import Path
from bootstrap import bootstrap
import os
os.umask(0o077)
p=Path('/data/.initializing');p.write_text('1')
try:
 rejected=False
 try:bootstrap()
 except RuntimeError:rejected=True
 assert rejected and p.read_text()=='1' and sorted(x.name for x in Path('/data').iterdir())==['.initializing']
 print('INTERRUPTED_BOOTSTRAP_REJECTED')
finally:p.unlink()
"""
        require(isolated(state, interrupted, volume).stdout.strip() == "INTERRUPTED_BOOTSTRAP_REJECTED",
                "Interrupted first bootstrap changed partial data or generated credentials")
        argv = fixture.guard.run_args(state["image"], state["public_key"], volume, state["owner"])
        argv = [{"127.0.0.1:8080:80": "127.0.0.1::80",
                 "127.0.0.1:2222:22": "127.0.0.1::22"}.get(a, a) for a in argv]
        fresh_state["container"] = subprocess.check_output(argv, text=True, timeout=30).strip()
        launched = True
        fixture.ready(fresh_state)
        print("persistence: second fresh full stack healthy", file=sys.stderr, flush=True)
        fresh = json.loads(fixture.execute(fresh_state, SNAPSHOT).stdout)
        require(all(fresh[k] != before[k] for k in ("state/keys.json", "ssh/ssh_host_ed25519_key")),
                "Fresh volumes reused generated service/SSH keys")
        unseeded = """import json,urllib.request
from common import run,env_for
setup=json.load(urllib.request.urlopen('http://127.0.0.1:5001/console/api/setup'))
assert setup['step']=='not_started'
assert run('postgres',['psql','-h','/run/dify/postgres','-U','dify_postgres','-d','dify',
 '-Atc','SELECT count(*) FROM accounts'],env=env_for('postgres')).stdout.strip()=='0'
print('NO_SEEDED_ADMIN')
"""
        require(fixture.execute(fresh_state, unseeded).stdout.strip() == "NO_SEEDED_ADMIN",
                "Fresh full startup seeded a Dify administrator")
        require(fixture.execute(fresh_state,
            "from pathlib import Path;assert not Path('/data/dev/.copilot').exists()",
            user="2000:2000").returncode == 0, "Fresh home imported host Copilot authentication")
    finally:
        if launched:
            from failure import remove_container
            remove_container(fresh_state)
        fixture.docker(["volume", "rm", volume])
