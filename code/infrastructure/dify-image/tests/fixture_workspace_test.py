"""Docker-free regressions for the persistent, per-user validation workspace."""
import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class FixtureWorkspaceTests(unittest.TestCase):
    """Keep fixture metadata private and portable across scenario imports."""

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="dify-workspace-test-")
        self.addCleanup(self.scratch.cleanup)
        self.home = Path(self.scratch.name) / "new-user"
        self.work = self.home / ".cache" / "ghc-dify" / "validation"

    def load_fixture(self):
        """Import with a synthetic home without executing any native commands."""
        source = Path(__file__).with_name("fixture.py")
        spec = importlib.util.spec_from_file_location("workspace_fixture", source)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        with patch.object(Path, "home", return_value=self.home):
            spec.loader.exec_module(module)
        # Never let a failing path assertion access an actual user's workspace.
        self.assertEqual(module.WORK, self.work)
        self.assertEqual(module.STATE, self.work / "state.json")
        return module

    # @verifies REQ-DIFYIMG-006
    def test_six_scenario_subprocesses_share_persistent_per_user_state(self):
        fixture = self.load_fixture()
        self.assertFalse(self.work.exists(), "Import must not create metadata")
        fixture.save({"owner": "synthetic-owner"})
        code = ("import fixture, json; print(json.dumps({"
                "'work': str(fixture.WORK), 'state': json.loads(fixture.STATE.read_text())}))")
        for _ in range(6):
            result = subprocess.run(
                [sys.executable, "-c", code], cwd=Path(__file__).parent,
                env={"HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1"},
                capture_output=True, text=True, timeout=15, check=True,
            )
            self.assertEqual(json.loads(result.stdout),
                             {"work": str(self.work), "state": {"owner": "synthetic-owner"}})
        self.home = Path(self.scratch.name) / "different-user"
        self.work = self.home / ".cache" / "ghc-dify" / "validation"
        self.assertFalse(self.load_fixture().STATE.exists())

    # @verifies REQ-DIFYIMG-006
    def test_save_creates_absent_cache_parents_with_private_metadata(self):
        fixture = self.load_fixture()
        self.assertFalse(self.home.exists())
        fixture.save({"owner": "synthetic-owner"})
        self.assertEqual(stat.S_IMODE(self.work.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(fixture.STATE.stat().st_mode), 0o600)
        self.assertFalse((self.work / "state.tmp").exists())

    # @verifies REQ-DIFYIMG-006
    def test_get_creates_absent_parents_before_locking(self):
        fixture = self.load_fixture()
        sentinel = {"owner": "synthetic-owner"}
        with patch.object(fixture, "_get", return_value=sentinel) as get:
            self.assertIs(fixture.get(), sentinel)
        get.assert_called_once_with()
        self.assertEqual(stat.S_IMODE(self.work.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.work / "fixture.lock").stat().st_mode), 0o600)

    # @verifies REQ-DIFYIMG-006
    def test_initialization_creates_absent_parents_before_key_generation(self):
        fixture = self.load_fixture()

        def keygen(*args, **kwargs):
            self.assertTrue(self.work.is_dir())
            self.assertEqual(stat.S_IMODE(self.work.stat().st_mode), 0o700)

        with (
            patch.object(fixture, "docker",
                         return_value=SimpleNamespace(stdout='[{"Id":"synthetic-image"}]')),
            patch.object(fixture.subprocess, "run", side_effect=keygen) as run,
            patch.object(fixture, "launch"),
            patch.object(fixture, "ready"),
        ):
            state = fixture._get()
        run.assert_called_once()
        self.assertEqual(state["private_key"], str(self.work / "test_ed25519"))


if __name__ == "__main__":
    unittest.main()
