"""Fingerprint only files used by the evaluation coordinator and tool runtime."""
import hashlib
from pathlib import Path


def source_digest(root: Path):
    files = []
    for directory in (root / "server", root / "src"):
        files.extend(p for p in directory.rglob("*") if p.is_file())
    files.extend(p for p in (root / "evals/harness").iterdir()
                 if p.is_file() and p.suffix in (".mjs", ".ts", ".json"))
    files.extend([root / "package.json", root / "package-lock.json"])
    digest = hashlib.sha256()
    for filename in sorted(files, key=lambda p: p.relative_to(root).as_posix()):
        digest.update(filename.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(filename.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def file_digest(filename: Path):
    with filename.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()
