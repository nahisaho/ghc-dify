"""Kill every healthy native role independently; observe bounded fail-closed exit."""
import concurrent.futures
import json
import subprocess
import time
import uuid

import fixture

ROLES = ("postgres", "redis", "api", "worker", "beat", "web", "plugin", "sandbox",
         "agent", "shellctl", "shell_broker", "squid", "agent_squid", "nginx", "sshd")
KILL = """import json,os,pathlib,signal,sys
from common import IDS
role=json.load(sys.stdin)
receipt=json.loads(pathlib.Path('/run/dify/readiness.json').read_text())
assert all(receipt['roles'].values())
pid=receipt['pids'][role];assert isinstance(pid,int) and pid>1
fd=os.pidfd_open(pid)
try:
 fields=dict(l.split(':',1) for l in pathlib.Path('/proc',str(pid),'status').read_text().splitlines() if ':' in l)
 assert list(map(int,fields['Uid'].split()))==[IDS[role]]*4
 signal.pidfd_send_signal(fd,signal.SIGKILL)
finally:os.close(fd)
print('OWNED_ROLE_KILLED')
"""


def remove_container(state):
    """Cleanup still works below the capacity floor, but never trusts a bare ID."""
    inspected = subprocess.run(["docker", "inspect", state["container"]],
                               capture_output=True, text=True, timeout=15, check=False)
    if inspected.returncode:
        return
    obj = json.loads(inspected.stdout)[0]
    assert obj["Config"]["Labels"].get(fixture.guard.LABEL) == state["owner"]
    subprocess.run(["docker", "rm", "--force", state["container"]],
                   check=True, capture_output=True, timeout=30)


def wave(base, roles):
    """Reuse only one owned volume per wave, never a failed role's live process."""
    state = dict(base)
    volume = "okayama-u-dify-failure-" + uuid.uuid4().hex[:12]
    fixture.docker(["volume", "create", "--label", fixture.guard.LABEL + "=" + state["owner"], volume])
    results = []
    try:
        for role in roles:
            launched = time.monotonic()
            argv = fixture.guard.run_args(state["image"], state["public_key"], volume, state["owner"])
            argv = [{"127.0.0.1:8080:80": "127.0.0.1::80",
                     "127.0.0.1:2222:22": "127.0.0.1::22"}.get(a, a) for a in argv]
            state["container"] = subprocess.check_output(argv, text=True, timeout=30).strip()
            try:
                fixture.ready(state)
                print(json.dumps({"role": role, "healthyAfterSeconds":
                                  round(time.monotonic() - launched, 2)}),
                      file=__import__("sys").stderr, flush=True)
                healthy = json.loads(fixture.execute(state,
                    "import json;print(open('/run/dify/readiness.json').read())").stdout)["roles"]
                assert set(healthy) == set(ROLES) and all(healthy.values())
                started = time.monotonic()
                fixture.execute(state, KILL, data=json.dumps(role))
                deadline = started + 30
                while time.monotonic() < deadline:
                    obj = fixture.owned(state)
                    if not obj["State"]["Running"]:
                        break
                    time.sleep(0.2)
                assert not obj["State"]["Running"], "Role failure did not shut down: " + role
                assert obj["State"]["ExitCode"] != 0, "Role failure exited as success: " + role
                # A stopped container cannot be ready or retain execution jobs.
                results.append(role)
                print("independent role failure passed: " + role, file=__import__("sys").stderr, flush=True)
            finally:
                remove_container(state)
    finally:
        obj = json.loads(subprocess.check_output(["docker", "volume", "inspect", volume], text=True))[0]
        assert obj.get("Labels", {}).get(fixture.guard.LABEL) == state["owner"]
        subprocess.run(["docker", "volume", "rm", volume], check=True,
                       capture_output=True, timeout=30)
    return results


def verify(state, require):
    """Never infer one role's failure propagation from another role's result."""
    # Three waves still exceeded the approved 570s outer bound: five sequential
    # full boot/shutdown cycles dominated. Measured stacks use about 1.9GiB;
    # five independent waves fit this 31GiB host without reducing any oracle.
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(wave, state, ROLES[offset::5]) for offset in range(5)]
        observed = [role for future in futures for role in future.result()]
    for role in ROLES:
        require(observed.count(role) == 1, "Missing independent role-failure evidence: " + role)
