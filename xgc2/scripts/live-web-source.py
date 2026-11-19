#!/usr/bin/env python3
"""Identify live browser inputs without reading unchanged Git blobs."""

import hashlib
import os
from pathlib import Path
import stat
import subprocess


ROOT = Path(__file__).resolve().parents[2]
# web/webpack.offline.config.ts owns its own entrypoint, tests and output.
# The source launcher serves the compiled bundle with its own runtime config.
LIVE = [".", ":(exclude)web/src/offline/**", ":(exclude)web/offline-tests/**",
        ":(exclude)web/webpack.offline.config.ts", ":(exclude)web/OFFLINE_RENDERING.md",
        ":(exclude)xgc2/launcher/**", ":(exclude)xgc2/tests/**", ":(exclude)xgc2/README.md"]


def git(*args, input=None):
    return subprocess.check_output(
        ["git", "-C", str(ROOT), "-c", "core.fileMode=true", "-c", "core.fsmonitor=false", *args],
        input=input, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_LAZY_FETCH": "1"},
    )


def fingerprint():
    # hash-object works with both repository formats and older host Git versions.
    empty_oid = git("hash-object", "--stdin", input=b"").strip()
    object_format = "sha256" if len(empty_oid) == 64 else "sha1"
    entries = {}
    changed = set(git("ls-files", "--modified", "--others", "--exclude-standard",
                      "-z", "--", *LIVE).split(b"\0"))
    changed.discard(b"")
    for entry in git("ls-files", "-v", "--stage", "-z", "--", *LIVE).split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        tag, mode, oid, stage = metadata.split()
        if stage != b"0":
            return ""
        entries[name] = (mode, oid)
        if tag != b"H" or mode not in (b"100644", b"100755"):
            changed.add(name)

    # suite-base/webpack.ts also reads this file when Git ignores it.
    changed.add(b".env")
    # Staging normalizes CRLF to LF while leaving the Webpack input on disk
    # untouched. Compare Git blob lengths without opening unchanged files.
    clean = {name: oid for name, (_, oid) in entries.items() if name not in changed}
    sizes = git("cat-file", "--batch-check=%(objectsize)",
                input=b"".join(oid + b"\n" for oid in clean.values())).splitlines()
    sizes_by_path = dict(zip(clean, map(int, sizes)))

    for name in entries.keys() | changed:
        path = ROOT / os.fsdecode(name)
        try:
            metadata = path.lstat()
        except (FileNotFoundError, NotADirectoryError):
            entries.pop(name, None)
            continue
        if not stat.S_ISREG(metadata.st_mode):
            if stat.S_ISDIR(metadata.st_mode) and name in entries and entries[name][0] != b"160000":
                # A tracked file was replaced by a directory. Untracked
                # children are already listed separately.
                del entries[name]
                continue
            # A link or nested repository can reach inputs outside this checkout.
            return ""
        mode = b"100755" if metadata.st_mode & stat.S_IXUSR else b"100644"
        if name not in changed and mode == entries[name][0] and metadata.st_size == sizes_by_path[name]:
            continue
        content = hashlib.new(object_format, f"blob {metadata.st_size}\0".encode())
        with path.open("rb") as src:
            for chunk in iter(lambda: src.read(1 << 20), b""):
                content.update(chunk)
        entries[name] = (mode, content.hexdigest().encode("ascii"))

    digest = hashlib.sha256(b"live-web-v2\0" + object_format.encode("ascii") + b"\0")
    for name, (mode, oid) in sorted(entries.items()):
        digest.update(mode + b" " + oid + b"\0" + name + b"\0")
    for key in (b"API_URL", b"DEV_WORKSPACE"):
        if key in os.environb:
            digest.update(b"env " + key + b"\0" + os.environb[key] + b"\0")
    return "sha256:" + digest.hexdigest()


if __name__ == "__main__":
    print(fingerprint())
