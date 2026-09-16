"""Reproducible setup, task selection, and dry-run campaign generation."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from evals.harness.provenance import source_digest, file_digest
DATASETS = {
    "deepswe": ("https://github.com/datacurve-ai/deep-swe.git", "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea", "tasks", 20),
    "terminal-2.1": ("https://github.com/harbor-framework/terminal-bench-2-1.git", "7131e4375048a0e408a8fb404b5f499d726b695b", "tasks", 10),
}


def run(args, **kwargs):
    subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def setup():
    for name, (url, revision, _, _) in DATASETS.items():
        target = HERE / "datasets" / name
        if not target.exists():
            run(["git", "clone", "--filter=blob:none", "--no-checkout", url, str(target)])
        dirty = subprocess.check_output(["git", "-C", str(target), "status", "--porcelain"], text=True)
        # A fresh --no-checkout clone reports tracked deletions; only check existing checkouts.
        if (target / "README.md").exists() and dirty.strip():
            raise RuntimeError(f"Dataset has local changes: {target}")
        run(["git", "-C", str(target), "checkout", "--detach", revision])


def build_runtime():
    artifacts = HERE / "artifacts"
    artifacts.mkdir(exist_ok=True)
    before = source_digest(ROOT)
    run(["docker", "build", "-f", "evals/harness/Dockerfile", "-t", "minnow-harness-runtime:local", "."])
    container = subprocess.check_output(["docker", "create", "minnow-harness-runtime:local"], text=True).strip()
    try:
        run(["docker", "cp", f"{container}:/runtime/minnow-runtime.tar.gz", str(artifacts / "minnow-runtime.tar.gz")])
    finally:
        run(["docker", "rm", container])
    if before != source_digest(ROOT):
        raise RuntimeError("Source changed during runtime build; rebuild before running evaluations")
    runtime = artifacts / "minnow-runtime.tar.gz"
    runtime.with_name(runtime.name + ".json").write_text(json.dumps({
        "source_sha256": before, "runtime_sha256": file_digest(runtime),
    }, indent=2), encoding="utf8")


def select_tasks(root, count, seed):
    tasks = [p.parent for p in root.rglob("task.toml") if (p.parent / "instruction.md").exists()]
    ranked = sorted(tasks, key=lambda p: hashlib.sha256(f"{seed}:{p.relative_to(root).as_posix()}".encode()).hexdigest())
    if len(ranked) < count:
        raise ValueError(f"Requested {count} tasks, only {len(ranked)} found under {root}")
    return ranked[:count]


def campaign(args):
    if not args.model:
        raise ValueError("--model is required")
    tasks = []
    for name, (_, revision, subdir, count) in DATASETS.items():
        checkout = HERE / "datasets" / name
        actual = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", str(checkout), "status", "--porcelain"], text=True).strip()
        if actual != revision or dirty:
            raise RuntimeError(f"Dataset {name} differs from the pinned clean checkout; run setup or restore its changes")
        root = checkout / subdir
        selected = select_tasks(root, min(count, 5) if args.smoke else count, args.seed)
        tasks += [{"path": str(p), "dataset": name, "revision": revision} for p in selected]
    manifest = {"model": args.model, "seed": args.seed, "attempts": args.attempts, "tasks": tasks,
                "note": "Local pilot subset, not a published full-suite score. Same tasks in both profiles."}
    folder = HERE / "artifacts" / args.name
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "selection.json").write_text(json.dumps(manifest, indent=2), encoding="utf8")
    for profile in ("build", "minimal"):
        config = {
            "job_name": f"{args.name}-{profile}", "jobs_dir": str(HERE / "jobs"),
            "n_attempts": args.attempts,
            # Rich's live progress renderer writes Braille spinner glyphs. On
            # legacy Windows consoles it can select cp1252 and crash its refresh
            # thread even though the trials themselves keep running.
            "quiet": os.name == "nt",
            "orchestrator": {"type": "local", "n_concurrent_trials": args.concurrency},
            "environment": {"type": "docker"},
            "agents": [{"import_path": "evals.harness.agent:MinnowAgent", "model_name": args.model,
                        "override_timeout_sec": args.timeout + 30,
                        "kwargs": {"profile": profile, "max_steps": args.max_steps,
                                   "max_tokens": args.max_tokens, "context_window": args.context_window,
                                   "timeout_seconds": args.timeout, "reasoning_effort": args.reasoning_effort}}],
            "tasks": [{"path": t["path"]} for t in tasks],
        }
        # Validate against the installed, locked evaluator before writing commands.
        from harbor.models.job.config import JobConfig
        validated = JobConfig.model_validate(config)
        target = folder / f"{profile}.json"
        target.write_text(validated.model_dump_json(indent=2), encoding="utf8")
        print(f'uv run --project evals/harness python -m harbor.cli.main run --config "{target}"')
    if args.baseline_model:
        baseline = {**config, "job_name": f"{args.name}-terminus", "agents": [{
            "name": "terminus-2", "model_name": args.baseline_model,
            "override_timeout_sec": args.timeout,
            "kwargs": {"max_turns": args.max_steps,
                       "reasoning_effort": args.reasoning_effort,
                       "llm_call_kwargs": {"max_tokens": args.max_tokens, "temperature": 1.0, "top_p": 0.95}}
        }]}
        validated = JobConfig.model_validate(baseline)
        target = folder / "terminus.json"
        target.write_text(validated.model_dump_json(indent=2), encoding="utf8")
        print(f'uv run --project evals/harness python -m harbor.cli.main run --config "{target}"')
    print(f"Prepared {len(tasks) * args.attempts * (3 if args.baseline_model else 2)} runs; no model calls made.")


def doctor():
    checks = {name: shutil.which(name) for name in ("node", "git", "docker", "uv")}
    try:
        checks["docker_server"] = subprocess.check_output(["docker", "info", "--format", "{{.OSType}}"], stderr=subprocess.DEVNULL, text=True, timeout=10).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        checks["docker_server"] = None
    checks["runtime"] = (HERE / "artifacts/minnow-runtime.tar.gz").is_file()
    checks["api_url_configured"] = bool(os.environ.get("MINNOW_EVAL_API_URL"))
    checks["api_key_configured"] = bool(os.environ.get("MINNOW_EVAL_API_KEY"))
    print(json.dumps(checks, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["doctor", "datasets", "runtime", "campaign"])
    parser.add_argument("--model")
    parser.add_argument("--baseline-model", help="Optional Terminus-2 baseline using a LiteLLM provider/model name; configure its provider credentials separately")
    parser.add_argument("--name", default="pilot")
    parser.add_argument("--seed", default="minnow-v1")
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--max-steps", type=int, default=500)
    parser.add_argument("--max-tokens", type=int, default=16384)
    parser.add_argument("--context-window", type=int, default=131072)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--reasoning-effort")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if Path(args.name).name != args.name or args.name in (".", ".."):
        parser.error("--name must be a single directory name")
    for value in (args.attempts, args.concurrency, args.max_steps, args.max_tokens, args.context_window, args.timeout):
        if value <= 0:
            parser.error("All budgets and counts must be positive")
    {"doctor": doctor, "datasets": setup, "runtime": build_runtime,
     "campaign": lambda: campaign(args)}[args.action]()
