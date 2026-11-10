"""Requirement scenario dispatcher: absent checks fail, no scenario may skip."""
import json
import sys
import threading
import traceback
from pathlib import Path

# The approved SDD runner enables PYTHONSAFEPATH. Import only this explicit,
# trusted test directory rather than relying on Python's implicit script path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

ASSERTIONS = 0
STOP = threading.Event()
CAPACITY_FAILED = threading.Event()


def monitor():
    """Keep sampling during long native HTTP/SSH/job operations, not just before."""
    import fixture
    while not STOP.is_set():
        try:
            fixture.guard.capacity()
        except Exception:  # noqa: BLE001 -- any measurement failure cancels owned work
            CAPACITY_FAILED.set()
            fixture.stop_owned()
            return
        STOP.wait(1)


def require(condition, label):
    """Count only actually executed assertions; never print compared secrets."""
    global ASSERTIONS
    ASSERTIONS += 1
    if not condition:
        raise AssertionError(label)


def main(number):
    """Dispatch only implemented native behavioral scenarios."""
    if number == "006":
        from guard_checks import verify
        verify(require)
    elif number in ("001", "004"):
        from integration import verify
        verify(number, require)
    elif number in ("003", "005"):
        from security import verify
        verify(number, require)
    elif number == "002":
        from persistence import verify
        verify(require)
    else:
        raise AssertionError("Unknown required scenario")
    require(ASSERTIONS > 0, "No behavioral assertions")
    require(not CAPACITY_FAILED.is_set(), "Dual-filesystem capacity guard cancelled validation")
    print(json.dumps({"scenario": number, "verdict": "PASS", "assertions": ASSERTIONS}))


if __name__ == "__main__":
    number = sys.argv[1]
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        main(number)
    except Exception as error:  # noqa: BLE001 -- redact all credential-bearing error details
        # HTTP exceptions contain credential-bearing native URLs: never str(error).
        detail = str(error) if isinstance(error, AssertionError) else "scenario execution incomplete"
        evidence = {"scenario": number, "verdict": "FAIL", "failure": type(error).__name__,
                    "detail": detail, "assertions": ASSERTIONS,
                    "frames": [{"file": Path(frame.filename).name, "line": frame.lineno}
                               for frame in traceback.extract_tb(error.__traceback__)]}
        print(json.dumps(evidence))
        # The compact native TDD reporter tails failures. Preserve only this
        # credential-free location evidence, not request bodies/URLs or locals.
        import fixture
        fixture.WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
        report = fixture.WORK / ("failure-" + number + ".json")
        report.write_text(json.dumps(evidence))
        report.chmod(0o600)
        raise SystemExit(1)
    finally:
        STOP.set()
        watcher.join(timeout=45)
