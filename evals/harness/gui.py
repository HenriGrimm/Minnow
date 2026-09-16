"""Settings campaign coordinator. Input is validated by the authenticated server."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from evals.harness.manage import campaign


def main():
    options = json.loads(sys.stdin.readline())
    args = argparse.Namespace(**options, baseline_model=None, seed="minnow-v1",
                              concurrency=1, reasoning_effort=None)
    campaign(args)
    folder = ROOT / "evals/harness/artifacts" / args.name
    jobs = folder / "jobs"
    # Keep each comparison isolated so reports never combine unrelated campaigns.
    for profile in ("build", "minimal"):
        target = folder / f"{profile}.json"
        config = json.loads(target.read_text(encoding="utf8"))
        config["jobs_dir"] = str(jobs)
        target.write_text(json.dumps(config, indent=2), encoding="utf8")
    failed = False
    try:
        for profile in ("build", "minimal"):
            print(f"Running {profile} profile", flush=True)
            result = subprocess.run([sys.executable, "-m", "harbor.cli.main", "run",
                                     "--config", str(folder / f"{profile}.json")], cwd=ROOT)
            failed = failed or result.returncode != 0
    finally:
        if jobs.exists():
            subprocess.run([sys.executable, "evals/harness/report.py", str(jobs)], cwd=ROOT)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
