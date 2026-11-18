#!/usr/bin/env python3
"""Identify the Git sources for web/webpack.config.ts without reading unchanged blobs."""

import hashlib
import os
from pathlib import Path
import stat
import subprocess


ROOT = Path(__file__).resolve().parents[2]
# web/webpack.offline.config.ts owns its own entrypoint, tests and output.
LIVE = [".", ":(exclude)web/src/offline/**", ":(exclude)web/offline-tests/**",
        ":(exclude)web/webpack.offline.config.ts", ":(exclude)web/OFFLINE_RENDERING.md"]


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def fingerprint():
    revision = git("rev-parse", "HEAD").strip()
    digest = hashlib.sha256(b"live-web-v1\0" + revision + b"\0")
    changed = git("status", "--porcelain=v1", "--no-renames", "--untracked-files=all",
                  "-z", "--", *LIVE).split(b"\0")
    for name in sorted({row[3:] for row in changed if row}):
        path = ROOT / os.fsdecode(name)
        digest.update(name + b"\0")
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            digest.update(b"deleted\0")
            continue
        if stat.S_ISREG(mode):
            content = hashlib.sha256()
            with path.open("rb") as src:
                for chunk in iter(lambda: src.read(1 << 20), b""):
                    content.update(chunk)
            digest.update((b"executable\0" if mode & stat.S_IXUSR else b"file\0") + content.digest())
        else:
            # A changed symlink can reach an untracked external source. Such
            # entries and nested repositories can still be built without reuse.
            return ""
    return "sha256:" + digest.hexdigest()


if __name__ == "__main__":
    print(fingerprint())
