"""Isolated stock-shellctl compatibility check; outputs booleans, never tokens."""
import json
import os
import secrets
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import guard

IMAGE = (
    "langgenius/dify-agent-local-sandbox@sha256:"
    "8b3a355f18b9660fdc9a709f7368370f01cb02c800e234b659f1803b3368900e"
)


def docker(args, *, data=None, env=None, check=True):
    """Keep arbitrary response bodies and command environments out of exceptions."""
    guard.capacity()
    result = subprocess.run(
        ["docker", *args], input=data, capture_output=True, text=True,
        env=env, timeout=30, check=False,
    )
    if check and result.returncode:
        raise RuntimeError("Owned Docker probe command failed")
    return result


def probe():
    """Exercise the actual authenticated HTTP job API with an inert canary."""
    owner = "shellctl-probe-" + str(uuid.uuid4())
    cid = None
    try:
        env = {**os.environ, "SHELLCTL_AUTH_TOKEN": secrets.token_urlsafe(32)}
        cid = docker([
            "create", "--pull=never", "--label", f"{guard.LABEL}={owner}",
            "--network=none", "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--user=1106:1106", "--memory=512m", "--cpus=1", "--pids-limit=128",
            "--tmpfs=/home/dify:uid=1106,gid=1106,mode=0700",
            "--tmpfs=/data:uid=1106,gid=1106,mode=0700",
            "--env", "SHELLCTL_AUTH_TOKEN", "--env", "HOME=/home/dify",
            "--env", "SHELLCTL_ENABLE_PATH_ISOLATION=true",
            IMAGE,
        ], env=env).stdout.strip()
        docker(["start", cid])
        deadline = time.monotonic() + 30
        health = [
            "exec", cid, "python", "-c",
            "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5004/healthz',timeout=1).read()",
        ]
        while time.monotonic() < deadline:
            if docker(health, check=False).returncode == 0:
                break
        else:
            raise RuntimeError("Stock shellctl health deadline exceeded")
        docker(["exec", cid, "python", "-c", (
            "import pathlib; p=pathlib.Path('/data/secrets/shellctl');"
            "p.mkdir(parents=True,mode=0o700);"
            "f=p/'key'; f.write_text('synthetic-not-a-secret'); f.chmod(0o600)"
        )])
        code = """import os,json,pathlib
r={'uid':os.getuid(),'gid':os.getgid(),'server_auth_in_proc':False,'service_file_readable':False}
for p in pathlib.Path('/proc').iterdir():
 try:
  if (p/'comm').read_text().strip()=='shellctl':
   r['server_auth_in_proc'] |= b'SHELLCTL_AUTH_TOKEN=' in (p/'environ').read_bytes()
 except (OSError,ValueError): pass
try:
 r['service_file_readable']=pathlib.Path('/data/secrets/shellctl/key').read_text()=='synthetic-not-a-secret'
except OSError: pass
print(json.dumps(r))
"""
        script = "python -c " + shlex.quote(code)
        helper = """import json,os,sys,urllib.request,urllib.error
payload=json.loads(sys.stdin.read())
url='http://127.0.0.1:5004/v1/jobs/run'
data=json.dumps(payload).encode()
try:
 urllib.request.urlopen(urllib.request.Request(url,data=data,headers={'Content-Type':'application/json'}),timeout=10)
 denied=False
except urllib.error.HTTPError as e: denied=e.code==401
req=urllib.request.Request(url,data=data,headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['SHELLCTL_AUTH_TOKEN']})
result=json.load(urllib.request.urlopen(req,timeout=25))
print(json.dumps({'unauthorized_denied':denied,'result':result}))
"""
        response = json.loads(docker(
            ["exec", "-i", cid, "python", "-c", helper],
            data=json.dumps({"script": script, "cwd": "/home/dify", "mode": "stdio", "timeout": 10}),
        ).stdout)
        result = response["result"]
        while not result["done"] and time.monotonic() < deadline:
            wait = """import json,os,sys,urllib.request
j=json.loads(sys.stdin.read())
req=urllib.request.Request('http://127.0.0.1:5004/v1/jobs/'+j['job_id']+'/wait',
 data=b'{"timeout":5,"offset":0}',
 headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['SHELLCTL_AUTH_TOKEN']})
print(json.dumps(json.load(urllib.request.urlopen(req,timeout=10))))
"""
            result = json.loads(docker(["exec", "-i", cid, "python", "-c", wait],
                                      data=json.dumps({"job_id": result["job_id"]})).stdout)
        report = {"unauthorized_denied": response["unauthorized_denied"],
                  "job_exit": result["exit_code"], "job_done": result["done"]}
        output = result.get("output", "")
        if result["exit_code"] == 0:
            parsed = json.loads(output.strip())
            report.update({k: parsed[k] for k in (
                "uid", "gid", "server_auth_in_proc", "service_file_readable")})
        else:
            report["failure"] = (
                "landlock-initialization-failed" if "Landlock" in output
                else "shell-job-failed"
            )
        return report
    finally:
        if cid:
            metadata = json.loads(docker(["inspect", cid]).stdout)[0]
            if metadata["Config"]["Labels"].get(guard.LABEL) != owner:
                raise RuntimeError("Owned cleanup label mismatch")
            docker(["rm", "--force", cid])


if __name__ == "__main__":
    try:
        print(json.dumps(probe()))
    except Exception as error:  # noqa: BLE001 -- print the exception class, never credentials
        print(json.dumps({"failure": type(error).__name__}))
        raise SystemExit(1)
