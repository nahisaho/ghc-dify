"""Live code/shell execution checks; only synthetic canaries reach job code."""
import concurrent.futures
import errno
import json
import shlex
import time

import fixture

HTTP = """import json,sys,urllib.request,urllib.error,time
from common import env_for
p=json.load(sys.stdin);role=p.pop('role');path=p.pop('path')
invalid=p.pop('invalid',False);env=env_for(role)
key=env['API_KEY' if role=='sandbox' else 'SHELLCTL_AUTH_TOKEN']
if invalid:key='deliberately-invalid'
headers={'Content-Type':'application/json'}
headers.update({'X-Api-Key':key} if role=='sandbox' else {'Authorization':'Bearer '+key})
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path,p):
 req=urllib.request.Request('http://127.0.0.1:'+('8194' if role=='sandbox' else '5004')+path,
  data=json.dumps(p).encode(),headers=headers)
 try:
  with opener.open(req,timeout=45) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,{}
status,result=call(path,p)
if role=='shellctl' and status==200:
 deadline=time.monotonic()+35
 while not result['done'] and time.monotonic()<deadline:
  status,result=call('/v1/jobs/'+result['job_id']+'/wait',{'timeout':5,'offset':0})
print(json.dumps({'http':status,'body':result}))
"""

METADATA = """import pathlib,json,stat
result=[]
for p in pathlib.Path('/proc').iterdir():
 try:
  s=dict(l.split(':',1) for l in (p/'status').read_text().splitlines() if ':' in l)
  uid=int(s['Uid'].split()[0])
  if 10000<=uid<11000:
   threads=[dict(l.split(':',1) for l in f.read_text().splitlines() if ':' in l)
    for f in (p/'task').glob('*/status')]
   result.extend([{k:t[k].strip() for k in ['Uid','Gid','Groups','CapInh','CapPrm',
    'CapEff','CapAmb','NoNewPrivs','Seccomp']} for t in threads])
 except (OSError,ValueError,KeyError):pass
files=[{'uid':f.stat().st_uid,'mode':stat.S_IMODE(f.stat().st_mode)}
 for f in pathlib.Path('/var/sandbox/sandbox-python/tmp').glob('*.py')]
print(json.dumps({'jobs':result,'bootstraps':files}))
"""

JOB = """import os,json,time
# Identity is observed externally through /proc, not self-reported by user code.
# Upstream Python's seccomp policy intentionally rejects the getgid syscall.
r={'denials':{},'unexpected_fds':[],
   'secret_env':any(any(x in k for x in ('SECRET','TOKEN','PASSWORD','API_KEY')) for k in os.environ)}
for n in ['/data/qualification-private','/data/qualification-public',
          '/data/ssh/ssh_host_ed25519_key','/data/secrets/api/env.json','/proc/1/environ']:
 try:open(n).read();r['denials'][n]='READABLE'
 except OSError as e:r['denials'][n]=e.errno
for fd in range(4,64):
 # Go's embedded runtime owns anonymous eventpoll/eventfd descriptors (type0).
 # Reject inherited files, pipes and sockets, not those non-secret kernel objects.
 try:
  if os.fstat(fd).st_mode & 0o170000:r['unexpected_fds'].append(fd)
 except OSError:pass
print(json.dumps(r),flush=True)
t=time.monotonic()+4
while time.monotonic()<t:pass
"""

BROKER_CLEANUP = """import base64,json,socket,time
def job(script,timeout):
 with socket.socket(socket.AF_UNIX) as sock:
  sock.settimeout(20);sock.connect('/run/dify/shell-broker.sock')
  sock.sendall(json.dumps({'script':script,'cwd':'/data/shellctl/home',
                          'env':{},'timeout':timeout}).encode()+b'\\n')
  output=b''
  with sock.makefile('rb') as lines:
   assert json.loads(lines.readline())=={'ready':True}
   for line in lines:
    event=json.loads(line)
    if 'exit_code' in event:return event['exit_code'],output
    if event.get('stream')=='stdout':output+=base64.b64decode(event['data'])
  raise AssertionError('Broker did not confirm exit and cleanup')
started=time.monotonic()
status,_=job('sleep 60 & wait',1)
assert status!=0 and time.monotonic()-started<20
status,out=job('printf LEASE_REUSE_OK',3)
assert status==0 and out==b'LEASE_REUSE_OK'
print('SHELL_DESCENDANT_TIMEOUT_AND_REUSE_OK')
"""


def call(state, role, payload, path=None, invalid=False):
    """Keep actual runtime authentication entirely within the container helper."""
    data = dict(payload, role=role, path=path or (
        "/v1/sandbox/run" if role == "sandbox" else "/v1/jobs/run"), invalid=invalid)
    return json.loads(fixture.execute(state, HTTP, data=json.dumps(data), timeout=70).stdout)


def metadata(state):
    """Observe every live job thread from outside its private root."""
    return json.loads(fixture.execute(state, METADATA).stdout)


def observed(state, role, payload, require):
    """Require live metadata plus exact successful output; a dead job cannot pass."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(call, state, role, payload)
        deadline = time.monotonic() + 15
        snapshot = {}
        while time.monotonic() < deadline:
            snapshot = metadata(state)
            if snapshot["jobs"]:
                break
            if future.done():
                break
            time.sleep(0.05)
        require(bool(snapshot.get("jobs")), "Live isolated job not observed: " + role)
        for thread in snapshot["jobs"]:
            require(all(10000 <= int(u) < 11000 for u in thread["Uid"].split()),
                    "Job real/effective/saved identity not pooled")
            require(all(int(g) == 1000 for g in thread["Gid"].split()) and not thread["Groups"],
                    "Job GID or supplementary group boundary")
            require(all(int(thread[k], 16) == 0 for k in ("CapInh", "CapPrm", "CapEff", "CapAmb")),
                    "Job retained an operative capability")
            require(thread["NoNewPrivs"] == "1" and thread["Seccomp"] == "2",
                    "Job security filters missing")
        if role == "sandbox":
            require(bool(snapshot["bootstraps"]) and all(
                f == {"uid": 0, "mode": 0o600} for f in snapshot["bootstraps"]),
                "Privileged Python bootstrap is absent or job-writable")
        result = future.result(timeout=60)
    require(result["http"] == 200, "Native job request failed")
    data = result["body"]["data"] if role == "sandbox" else result["body"]
    require(not data.get("error") and data.get("exit_code", 0) == 0, "Native job execution failed")
    parsed = json.loads(data.get("stdout", data.get("output", "")).strip())
    require(not parsed["secret_env"] and not parsed["unexpected_fds"],
            "Job inherited a service secret or descriptor")
    require(all(v == errno.ENOENT for v in parsed["denials"].values()),
            "Private root exposes service data or proc environments")
    require(not metadata(state)["jobs"], "Job UID still live after completion")


def verify(state, require):
    """Code and shell brokers must both preserve the approved isolation policy."""
    fixture.execute(state, """from pathlib import Path
for name,mode in [('qualification-private',0o600),('qualification-public',0o644)]:
 p=Path('/data')/name;p.write_text('synthetic-no-runtime-secret');p.chmod(mode)
assert Path('/data/qualification-public').read_text()=='synthetic-no-runtime-secret'
""")
    # Match Dify's real Code executor. No network-isolation claim is made by this
    # single-namespace product; do not broaden the upstream syscall policy.
    observed(state, "sandbox", {"language": "python3", "code": JOB, "enable_network": True}, require)
    observed(state, "shellctl", {"script": "python3 -c " + shlex.quote(JOB),
                                "cwd": "/data/shellctl/home", "mode": "stdio", "timeout": 12}, require)
    node = call(state, "sandbox", {"language": "nodejs", "code": "console.log(42)", "enable_network": False})
    require(node["http"] == 200 and node["body"]["data"]["stdout"].strip() == "42",
            "Native Node execution failed")
    require(call(state, "sandbox", {"language": "nodejs", "code": "console.log(42)"},
                 invalid=True)["http"] == 401, "Invalid sandbox token admitted")
    require(call(state, "shellctl", {"script": "true", "mode": "stdio"}, invalid=True)["http"] == 401,
            "Invalid shellctl token admitted")
    require(call(state, "sandbox", {"language": "python3", "code": "print(42)", "preload": "x"})["http"] == 400,
            "Privileged user preload admitted")
    require(call(state, "sandbox", {}, path="/v1/sandbox/dependencies/update")["http"] == 404,
            "Runtime dependency mutation admitted")
    timed = call(state, "sandbox", {"language": "nodejs", "code": "while(true){}", "enable_network": True})
    require("timeout" in timed["body"]["data"]["error"].lower(), "Code timeout not enforced")
    require(not metadata(state)["jobs"] and not metadata(state)["bootstraps"],
            "Timed-out job or privileged bootstrap survived cleanup")
    require(fixture.execute(state, BROKER_CLEANUP, user="1106:1106", timeout=45).stdout.strip()
            == "SHELL_DESCENDANT_TIMEOUT_AND_REUSE_OK",
            "Shell descendant timeout or serialized UID reuse failed")
    require(not metadata(state)["jobs"], "Shell descendant survived completed lease cleanup")
