"""Bounded candidate-only assertions; not all-in-one requirement qualification."""
import concurrent.futures
import errno
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import guard

IMAGE = "okayama-u/dify-sandbox-candidate:0.2.15-local"


def docker(args, data=None, env=None, check=True):
    """Run only bounded owned operations without returning credential-bearing errors."""
    guard.capacity()
    result = subprocess.run(["docker", *args], input=data, capture_output=True,
                            text=True, timeout=30, env=env, check=False)
    if check and result.returncode:
        raise RuntimeError(f"Sandbox fixture Docker {args[0]} failed ({result.returncode}): {result.stderr[-600:]}")
    return result


def probe():
    """Check root-owned bootstrap, all Python threads, canaries and timeout cleanup."""
    owner = "sandbox-probe-" + str(uuid.uuid4())
    cid = None
    try:
        env = {**os.environ, "API_KEY": secrets.token_urlsafe(32)}
        args = ["create", "--pull=never", "--label", f"{guard.LABEL}={owner}",
                "--network=none", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--memory=1g", "--cpus=1", "--pids-limit=128",
                "--env", "API_KEY", "--env", "WORKER_TIMEOUT=6", IMAGE]
        for cap in ("CHOWN", "SETUID", "SETGID", "SYS_CHROOT"):
            args[-1:-1] = ["--cap-add", cap]
        cid = docker(args, env=env).stdout.strip()
        docker(["start", cid])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            result = docker(["exec", cid, "/usr/local/bin/python3", "-c",
                             "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8194/health',timeout=1).read()"], check=False)
            if result.returncode == 0:
                break
        else:
            raise RuntimeError("Candidate health deadline")
        docker(["exec", cid, "/usr/local/bin/python3", "-c", """import pathlib
p=pathlib.Path('/data');p.mkdir(mode=0o755)
for name,mode in [('secret',0o600),('ssh-key',0o600),('public',0o644)]:
 f=p/name;f.write_text('synthetic-not-a-secret');f.chmod(mode)
assert not list(pathlib.Path('/etc/ssh').glob('ssh_host_*_key'))
"""])
        request = """import json,os,sys,urllib.request,urllib.error
p=json.loads(sys.stdin.read())
req=urllib.request.Request('http://127.0.0.1:8194'+p.pop('path','/v1/sandbox/run'),
 data=json.dumps(p).encode(),headers={'Content-Type':'application/json','X-Api-Key':os.environ['API_KEY']})
try:
 r=urllib.request.urlopen(req,timeout=20)
 print(json.dumps({'http':r.status,'body':json.load(r)}))
except urllib.error.HTTPError as e: print(json.dumps({'http':e.code}))
"""

        def call(payload):
            return json.loads(docker(["exec", "-i", cid, "/usr/local/bin/python3", "-c", request],
                                     json.dumps(payload)).stdout)

        if "--diagnostic" in sys.argv:
            results = {}
            for name, code in (("constant", "print(42)"),
                               ("uid", "import os;print(os.getuid())"),
                               ("json", "import json;print(json.dumps({'answer':42}))")):
                results[name] = call({"language": "python3", "code": code, "enable_network": False})
            return {"diagnostic_only": True, "controls": results}

        pycode = """import os,json,time
r={'uid':os.getuid(),'denials':{}}
for n in ['secret','ssh-key','public']:
 try:
  open('/data/'+n).read();r['denials'][n]='READABLE'
 except OSError as e:r['denials'][n]=e.errno
print(json.dumps(r),flush=True)
t=time.monotonic()+4
while time.monotonic()<t: pass
"""
        metadata = """import pathlib,json,stat
result=[]
for p in pathlib.Path('/proc').iterdir():
 try:
  s=dict(l.split(':',1) for l in (p/'status').read_text().splitlines() if ':' in l)
  uid=int(s['Uid'].split()[0])
  if uid>=10000 and uid<11000:
   threads=[dict(l.split(':',1) for l in f.read_text().splitlines() if ':' in l) for f in (p/'task').glob('*/status')]
   result.append([{k:t[k].strip() for k in ['Uid','Groups','CapInh','CapPrm','CapEff','CapAmb','NoNewPrivs','Seccomp']} for t in threads])
 except (OSError,ValueError,KeyError):pass
files=[{'uid':f.stat().st_uid,'mode':stat.S_IMODE(f.stat().st_mode)} for f in pathlib.Path('/var/sandbox/sandbox-python/tmp').glob('*.py')]
print(json.dumps({'jobs':result,'bootstraps':files}))
"""
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(call, {"language": "python3", "code": pycode, "enable_network": False})
            inspect_until = time.monotonic() + 8
            observed = {}
            while time.monotonic() < inspect_until:
                observed = json.loads(docker(["exec", cid, "/usr/local/bin/python3", "-c", metadata]).stdout)
                if observed["jobs"] and observed["bootstraps"]:
                    break
                if future.done():
                    break
            if not (observed.get("jobs") and observed.get("bootstraps")):
                # This fixture executes only the literal synthetic code above.
                result = future.result(timeout=20)
                raise AssertionError("Live Python job not observed; fixture result: " + json.dumps(result))
            for job in observed["jobs"]:
                for thread in job:
                    assert all(10000 <= int(u) < 11000 for u in thread["Uid"].split())
                    assert thread["Groups"] == ""
                    assert all(int(thread[f], 16) == 0 for f in ["CapInh", "CapPrm", "CapEff", "CapAmb"])
                    assert thread["NoNewPrivs"] == "1" and thread["Seccomp"] == "2"
            assert all(f == {"uid": 0, "mode": 0o600} for f in observed["bootstraps"])
            response = future.result(timeout=20)
        assert response["http"] == 200 and response["body"]["code"] == 0
        data = response["body"]["data"]
        assert not data["error"], "Python execution failed"
        result = json.loads(data["stdout"])
        assert all(value == errno.ENOENT for value in result["denials"].values())
        normal = call({"language": "nodejs", "code": "console.log(42)", "enable_network": False})
        assert normal["body"]["data"]["stdout"].strip() == "42"
        assert call({"language": "nodejs", "code": "console.log(42)", "preload": "x"})["http"] == 400
        assert call({"path": "/v1/sandbox/dependencies/update", "language": "python3"})["http"] == 404
        timed = call({"language": "nodejs", "code": "while(true){}", "enable_network": False})
        assert "timeout" in timed["body"]["data"]["error"]
        after = json.loads(docker(["exec", cid, "/usr/local/bin/python3", "-c", metadata]).stdout)
        assert not after["jobs"] and not after["bootstraps"], "Job or bootstrap survived cleanup"
        return {"python_all_threads_cap0": True, "python_bootstrap_root0600": True,
                "python_data_denied": True, "node_answer": 42, "preload_rejected": True,
                "dependency_mutation_rejected": True, "timeout_cleanup": True}
    except Exception:
        if cid:
            logs = docker(["logs", "--tail", "20", cid], check=False)
            safe_logs = (logs.stdout + logs.stderr).replace(env["API_KEY"], "<redacted>")
            print(json.dumps({"candidate_logs": safe_logs[-4000:]}), file=sys.stderr)
        raise
    finally:
        if cid:
            metadata = json.loads(docker(["inspect", cid]).stdout)[0]
            if metadata["Config"]["Labels"].get(guard.LABEL) != owner:
                raise RuntimeError("Owned cleanup label mismatch")
            docker(["rm", "--force", cid])


if __name__ == "__main__":
    try:
        print(json.dumps(probe()))
    except Exception as error:  # noqa: BLE001 -- report only sanitized fixture failures
        # Assertion messages above contain only fixture categories, not keys/bodies.
        print(json.dumps({"failure": type(error).__name__, "detail": str(error) if isinstance(error, (AssertionError, RuntimeError)) else "fixture execution failed"}))
        raise SystemExit(1)
