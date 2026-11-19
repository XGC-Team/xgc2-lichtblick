import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


class LiveWebSourceTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "viewer"
        self.root.mkdir()
        self.scripts = self.root / "xgc2/scripts"
        self.scripts.mkdir(parents=True)
        for name in ("build-web.sh", "live-web-source.py"):
            shutil.copy2(SCRIPTS / name, self.scripts / name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.root / "package.json").write_text('{"version":"1.27.0"}')
        (self.root / ".gitignore").write_text(".work/\nweb/.webpack/\nweb/build-info.json\n")
        self.live = self.root / "web/src/entrypoint.tsx"
        self.live.parent.mkdir(parents=True)
        self.live.write_text("source A")
        self.offline = self.live.parent / "offline/renderer.ts"
        self.offline.parent.mkdir()
        self.offline.write_text("offline A")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        revision = self.git("rev-parse", "HEAD").strip()
        lock = self.root / "xgc2/upstream.lock"
        lock.write_text(f"LICHTBLICK_YARN_VERSION=4.0.0\nLICHTBLICK_NODE_MAJOR=18\n"
                        f"LICHTBLICK_UPSTREAM_VERSION=1.27.0\nLICHTBLICK_UPSTREAM_SHA={revision}\n")
        self.git("add", "xgc2/upstream.lock")
        self.git("commit", "-qm", "lock")
        bin_dir = self.root.parent / "bin"
        bin_dir.mkdir()
        corepack = bin_dir / "corepack"
        corepack.write_text("""#!/bin/sh
set -eu
case "$*" in
  'yarn --version') echo 4.0.0 ;;
  'yarn web:build:prod')
    if test -n "${TEST_BUILD_GUARD:-}"; then
      mkdir "$TEST_BUILD_GUARD" || exit 68
      trap 'rmdir "$TEST_BUILD_GUARD"' EXIT
      sleep 0.1
    fi
    if test "${CHANGE_SOURCE:-}" = yes; then echo changed >> web/src/entrypoint.tsx; fi
    if test "${FAIL_BUILD:-}" = yes; then exit 66; fi
    out="${LICHTBLICK_WEB_OUTPUT_DIR:-web/.webpack}"
    mkdir -p "$out"
    cp web/src/entrypoint.tsx "$out/index.html" ;;
  *) exit 67 ;;
esac
""")
        corepack.chmod(0o755)
        self.env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                        XGC2_LICHTBLICK_SKIP_INSTALL="1")
        self.env.pop("LICHTBLICK_WEB_OUTPUT_DIR", None)
        self.receipt = self.root / "web/build-info.json"

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def key(self, **env):
        return subprocess.check_output([sys.executable, str(self.scripts / "live-web-source.py")],
                                       cwd=self.root, env={**self.env, **env}, text=True).strip()

    def build(self, **env):
        return subprocess.run(["bash", str(self.scripts / "build-web.sh")], cwd=self.root,
                              env={**self.env, **env}, text=True, capture_output=True)

    def test_only_changed_live_inputs_affect_the_key(self):
        original = self.key()
        self.offline.write_text("offline change")
        self.git("add", "web/src/offline/renderer.ts")
        self.assertEqual(self.key(), original)
        self.live.write_text("source B")
        edited = self.key()
        self.assertNotEqual(edited, original)
        self.git("add", "web/src/entrypoint.tsx")
        self.assertEqual(self.key(), edited)
        self.live.chmod(0o755)
        self.assertNotEqual(self.key(), edited)
        self.live.chmod(0o644)
        new = self.root / "web/src/new module.ts"
        new.write_text("first")
        added = self.key()
        new.write_text("second")
        self.assertNotEqual(self.key(), added)
        new.unlink()
        new.symlink_to(self.root.parent / "outside")
        self.assertEqual(self.key(), "")
        new.unlink()
        self.assertEqual(self.key(), edited)
        self.live.unlink()
        self.assertNotEqual(self.key(), edited)

    def test_launcher_and_offline_commits_keep_the_key(self):
        original = self.key()
        launcher = self.root / "xgc2/launcher/prepare-layout.cjs"
        launcher.parent.mkdir()
        launcher.write_text("runtime layout")
        self.offline.write_text("offline B")
        (self.root / "xgc2/README.md").write_text("launcher documentation")
        self.assertEqual(self.key(), original)
        self.git("add", ".")
        self.git("commit", "-qm", "runtime layout and offline renderer")
        self.assertEqual(self.key(), original)

        self.live.write_text("live B")
        edited = self.key()
        self.assertNotEqual(edited, original)
        self.git("add", ".")
        self.git("commit", "-qm", "live renderer")
        self.assertEqual(self.key(), edited)
        self.git("commit", "--allow-empty", "-qm", "unrelated revision")
        self.assertEqual(self.key(), edited)

    def test_unstaged_mode_and_assume_unchanged_bytes_affect_key(self):
        original = self.key()
        self.git("config", "core.filemode", "false")
        self.live.chmod(0o755)
        self.assertNotEqual(self.key(), original)
        self.live.chmod(0o644)
        self.git("update-index", "--assume-unchanged", "web/src/entrypoint.tsx")
        self.assertEqual(self.key(), original)
        self.live.write_text("different content behind the same index entry")
        self.assertNotEqual(self.key(), original)

    def test_staging_does_not_hide_worktree_line_endings(self):
        (self.root / ".gitattributes").write_text("* text=auto eol=lf\n")
        self.live.write_bytes(b"source A\n")
        self.git("add", ".")
        self.git("commit", "-qm", "LF checkout")
        original = self.key()
        self.live.write_bytes(b"source A\r\n")
        edited = self.key()
        self.assertNotEqual(edited, original)
        self.git("add", "web/src/entrypoint.tsx")
        self.assertEqual(self.key(), edited)
        self.live.write_bytes(b"source A\n")
        self.assertEqual(self.key(), original)

    def test_compile_environment_affects_key(self):
        (self.root / ".git/info/exclude").write_text(".env\n")
        default = self.key()
        self.assertNotEqual(self.key(API_URL="https://build.invalid"), default)
        self.assertNotEqual(self.key(DEV_WORKSPACE="build-fixture"), default)
        (self.root / ".env").write_text("DEV_WORKSPACE=from-dotenv\n")
        self.assertNotEqual(self.key(), default)
        (self.root / ".env").unlink()
        self.assertEqual(self.key(), default)

    def test_receipt_describes_the_successful_build(self):
        self.live.write_text("staged source")
        self.git("add", "web/src/entrypoint.tsx")
        build = self.build()
        self.assertEqual(build.returncode, 0, build.stderr)
        receipt = json.loads(self.receipt.read_bytes())
        self.assertTrue(receipt["sourceDirty"])
        self.assertEqual(receipt["liveSourceFingerprint"], self.key())
        preview = self.root.parent / "preview"
        alternate = self.build(LICHTBLICK_WEB_OUTPUT_DIR=str(preview))
        self.assertEqual(alternate.returncode, 0, alternate.stderr)
        self.assertEqual(json.loads((preview / "build-info.json").read_bytes()), receipt)
        self.assertEqual(json.loads(self.receipt.read_bytes()), receipt)
        self.assertNotEqual(self.build(CHANGE_SOURCE="yes").returncode, 0)
        self.assertFalse(self.receipt.exists())
        self.assertEqual(self.build().returncode, 0)
        self.assertEqual(self.build(FAIL_BUILD="yes").returncode, 66)
        self.assertFalse(self.receipt.exists())

    def test_builds_in_one_checkout_keep_a_single_writer(self):
        guard = str(self.root.parent / "active-builder")
        with ThreadPoolExecutor(max_workers=2) as pool:
            builds = [pool.submit(self.build, TEST_BUILD_GUARD=guard) for _ in range(2)]
            self.assertEqual([build.result().returncode for build in builds], [0, 0])
        self.assertFalse(Path(guard).exists())


if __name__ == "__main__":
    unittest.main()
