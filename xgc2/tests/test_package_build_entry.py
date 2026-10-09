"""Exercise the packaging boundary without starting a container or a build."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class BuildEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in (".xgc2/scripts/build_deb_in_docker.sh", "xgc2/upstream.lock"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        (self.root / "source.txt").write_text("committed\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "source")
        self.sha = self.git("rev-parse", "HEAD").strip()
        (self.root / "source.txt").write_text("concurrent WIP\n")
        (self.root / "untracked.txt").write_text("must not enter package\n")
        tools = self.root / "tools"
        tools.mkdir()
        docker = tools / "docker"
        docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
entry = {"args": args}
if args[0] == "run" and any(arg.startswith("XGC2_BUILD_UID=") for arg in args):
    mounts = [args[i + 1] for i, arg in enumerate(args) if arg == "-v"]
    source = pathlib.Path(next(m[:-len(":/workspace/source")] for m in mounts if m.endswith(":/workspace/source")))
    entry["source"] = (source / "source.txt").read_text()
    entry["untracked"] = (source / "untracked.txt").exists()
with open(os.environ["DOCKER_CALLS"], "a") as log:
    log.write(json.dumps(entry) + "\\n")
if args[0] == "run" and any(arg.startswith("XGC2_BUILD_UID=") for arg in args) and os.environ.get("FAIL_BUILD"):
    sys.exit(17)
''')
        docker.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{tools}:{os.environ['PATH']}",
                    "DOCKER_CALLS": str(self.root / "calls.jsonl")}

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True)

    def run_entry(self):
        result = subprocess.run(
            ["bash", ".xgc2/scripts/build_deb_in_docker.sh", "--work-dir", "work",
             "--output-dir", "debs", "--architecture", "amd64"],
            cwd=self.root, env=self.env, capture_output=True, text=True)
        calls = [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]
        return result, calls

    def test_committed_source_and_separate_readonly_install_check(self):
        result, calls = self.run_entry()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)
        build, smoke = calls[1], calls[2]
        self.assertEqual(build["source"], "committed\n")
        self.assertFalse(build["untracked"])
        self.assertIn(f"XGC2_SOURCE_SHA={self.sha}", build["args"])
        self.assertIn(f"XGC2_BUILD_UID={os.getuid()}", build["args"])
        self.assertIn(f"XGC2_BUILD_GID={os.getgid()}", build["args"])
        self.assertNotIn("--user", smoke["args"])
        mounts = [smoke["args"][i + 1] for i, arg in enumerate(smoke["args"]) if arg == "-v"]
        self.assertTrue(all(m.endswith(":ro") for m in mounts))
        self.assertEqual(list((self.root / "work").iterdir()), [])
        self.assertEqual((self.root / "source.txt").read_text(), "concurrent WIP\n")

    def test_failed_build_never_installs_and_cleans_export(self):
        self.env["FAIL_BUILD"] = "1"
        result, calls = self.run_entry()
        self.assertEqual(result.returncode, 17)
        self.assertEqual(len(calls), 2)
        self.assertEqual(list((self.root / "work").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
