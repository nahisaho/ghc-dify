"""Focused F1/F2 lifecycle controls against the actual frozen image filesystem."""
import json
import subprocess
import uuid
from pathlib import Path

import fixture


def verify_isolated(require, mutation=None):
    """Run real broker forks/chroots with only the approved container cap ceiling."""
    owner = "shell-regression-" + uuid.uuid4().hex
    code = Path(__file__).with_name("shell_cases.py").read_text()
    mutants = {
        "roots": ("copied", "b.recover_roots=lambda:None"),
        "home": ("copied", "b.recover_home=lambda:None"),
        "containment": ("output", "def fail(*a):raise b.UnsafeState('injected')\nb.reply_error=fail"),
        "special": ("fifo", """import shell_state as st
source=Path(st.__file__).read_text()
anchor='os.unlink(name, dir_fd=parent_fd)'
assert source.count(anchor)==1
exec(compile(source.replace(anchor,"raise UnsafeState('injected special node')"),
 st.__file__,'exec'),st.__dict__)
b.ownership=st.ownership"""),
        "unsafe": ("unsafe_cleanup", """original_handle=b.handle
def swallow(c):
 try:original_handle(c)
 except b.UnsafeState:b.reply_error(c,b.JobError('injected unsafe containment'))
b.handle=swallow"""),
    }
    if mutation:
        selected, injection = mutants[mutation]
        assert code.count("b.main()") == 1
        code = code.replace("b.main()", injection + "\nb.main()")
        code = code.replace("results = []",
                            f"cases=[(n,r) for n,r in cases if n=={selected!r}]; results = []")
    cid = fixture.docker([
        "create", "--pull=never", "--network=none", "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true", "--pids-limit=128", "--memory=1g",
        "--label", fixture.guard.LABEL + "=" + owner,
        *[value for cap in ("CHOWN", "SETUID", "SETGID", "KILL", "SYS_CHROOT")
          for value in ("--cap-add", cap)],
        "--entrypoint=/usr/bin/tini", fixture.guard.IMAGE,
        "--", "/usr/local/bin/python3", "-c", code,
    ]).stdout.strip()
    try:
        result = fixture.docker(["start", "--attach", cid], timeout=180, check=False)
        # This container has no mounts, provider keys or initialized service data.
        require(result.returncode == 0, "Isolated shell case driver: "
                + (result.stderr[-2000:] if result.returncode else "completed"))
        cases = json.loads(result.stdout)
        fixture.WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
        evidence = fixture.WORK / (owner + ".json")
        evidence.write_text(json.dumps(cases))
        evidence.chmod(0o600)
        expected = 1 if mutation else 20
        require(len(cases) == expected and len({c["case"] for c in cases}) == expected,
                "Missing or duplicate shell recovery/error case")
        for case in cases:
            require(case["passed"], "Shell recovery/error regression: " + case["case"]
                    + (" " + case.get("detail", "") if not case["passed"] else ""))
    finally:
        obj = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
        assert obj["Config"]["Labels"].get(fixture.guard.LABEL) == owner
        subprocess.run(["docker", "rm", "--force", cid], check=True,
                       capture_output=True, timeout=30)


def verify_restart(state, require):
    """SIGKILL the real whole container with an observed live job, then start it."""
    from jobs import call, metadata
    from persistence import SNAPSHOT
    before = fixture.execute(state, SNAPSHOT).stdout
    committed = call(state, "shellctl", {
        "script": "printf CRASH_COMMITTED > crash-sentinel",
        "cwd": "/data/shellctl/home", "mode": "stdio"})
    require(committed["body"].get("exit_code") == 0, "Crash sentinel did not commit")
    client = """
import base64,json,socket
with socket.socket(socket.AF_UNIX) as s:
 s.connect('/run/dify/shell-broker.sock')
 s.sendall(json.dumps({'script':'printf UNCOMMITTED > crash-sentinel; printf ACTIVE_CRASH_JOB; sleep 120 & wait',
  'cwd':'/home/dify','env':{},'timeout':180}).encode()+b'\\n')
 with s.makefile('rb') as lines:
  for line in lines:
   event=json.loads(line)
   if event.get('stream')=='stdout':
    assert base64.b64decode(event['data'])==b'ACTIVE_CRASH_JOB'
    print('ACTIVE_CRASH_JOB',flush=True)
"""
    started = fixture.execute(state, """import json,select,subprocess,sys
code=json.load(sys.stdin)
p=subprocess.Popen(['/usr/local/bin/python3','-c',code],user=1106,group=1106,
 extra_groups=[],env={},stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
assert select.select([p.stdout],[],[],15)[0],'No live crash lease'
assert p.stdout.readline()==b'ACTIVE_CRASH_JOB\\n'
print('ACTIVE_CRASH_JOB')
""", data=json.dumps(client), timeout=25)
    require(started.stdout.strip() == "ACTIVE_CRASH_JOB" and bool(metadata(state)["jobs"]),
            "Active job crash regression did not observe a real lease")
    fixture.owned(state)
    fixture.docker(["kill", state["container"]])
    fixture.docker(["start", state["container"]])
    fixture.ready(state)
    require(fixture.execute(state, SNAPSHOT).stdout == before,
            "Transient lease recovery modified persistent credential seals")
    require(not metadata(state)["jobs"], "Crash restart retained a leased process")
    result = call(state, "shellctl", {
        "script": "cat crash-sentinel; printf RESTART_REUSE",
        "cwd": "/data/shellctl/home", "mode": "stdio"})
    require(result["body"].get("exit_code") == 0
            and result["body"].get("output") == "CRASH_COMMITTEDRESTART_REUSE",
            "Active crash restart lost committed home or failed the next job")
