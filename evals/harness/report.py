"""Summarize independently graded Harbor trials; never grade assistant prose."""
import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path


def collect(root):
    rows = []
    for filename in sorted(root.rglob("result.json")):
        data = json.loads(filename.read_text(encoding="utf8"))
        if "task_name" not in data or "trial_name" not in data:
            continue
        agent = data.get("agent_result") or {}
        rewards = (data.get("verifier_result") or {}).get("rewards") or {}
        reward = rewards.get("reward")
        error = data.get("exception_info")
        config = data.get("config") or {}
        profile = ((config.get("agent") or {}).get("kwargs") or {}).get("profile") or (data.get("agent_info") or {}).get("name", "unknown")
        metrics = (agent.get("metadata") or {}).get("minnow") or {}
        rows.append({"task": data["task_name"], "trial": data["trial_name"], "profile": profile,
                     "model": (data.get("agent_info") or {}).get("model_info", {}).get("name") if (data.get("agent_info") or {}).get("model_info") else None,
                     "reward": reward, "passed": reward == 1 and not error,
                     "status": "error" if error else "ungraded" if reward is None else "graded",
                     "input_tokens": agent.get("n_input_tokens"), "output_tokens": agent.get("n_output_tokens"),
                     "cost_usd": agent.get("cost_usd"), "duration_ms": metrics.get("durationMs"),
                     "tool_calls": metrics.get("toolCalls"), "tool_errors": metrics.get("toolErrors"),
                     "compactions": metrics.get("compactions"), "source": str(filename)})
    return rows


def summarize(rows):
    grouped = defaultdict(list)
    for row in rows:
        key = f"{row.get('model')} / {row['profile']}" if row.get('model') else row['profile']
        grouped[key].append(row)
    result = {}
    for profile, trials in grouped.items():
        passed = sum(t["passed"] for t in trials)
        costs = [t["cost_usd"] for t in trials]
        total_cost = sum(costs) if all(c is not None for c in costs) else None
        result[profile] = {"trials": len(trials), "passed": passed,
                           "pass_rate_all_trials": passed / len(trials),
                           "errors": sum(t["status"] == "error" for t in trials),
                           "ungraded": sum(t["status"] == "ungraded" for t in trials),
                           "total_cost_usd": total_cost,
                           "cost_per_success_usd": total_cost / passed if passed and total_cost is not None else None}
    return result


def paired(rows):
    tasks = defaultdict(lambda: defaultdict(list))
    for row in rows:
        tasks[(row.get("model"), row["task"])][row["profile"]].append(row)
    output = []
    for (model, task), profiles in sorted(tasks.items(), key=lambda item: str(item[0])):
        if "build" in profiles and "minimal" in profiles:
            rates = {p: sum(r["passed"] for r in profiles[p]) / len(profiles[p]) for p in ("build", "minimal")}
            output.append({"model": model, "task": task, "build": rates["build"], "minimal": rates["minimal"],
                           "difference": rates["build"] - rates["minimal"],
                           "attempts": {p: len(profiles[p]) for p in ("build", "minimal")}})
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jobs", type=Path)
    parser.add_argument("--input-per-million", type=float, help="Optional uncached USD rate for a conservative token-cost estimate")
    parser.add_argument("--output-per-million", type=float)
    parser.add_argument("--project-runs", type=int, help="Estimate total campaign cost from this pilot's mean token cost")
    args = parser.parse_args()
    rows = collect(args.jobs)
    if not rows:
        parser.error("No trial results found")
    report = summarize(rows)
    if (args.input_per_million is None) != (args.output_per_million is None):
        parser.error("Supply both input and output rates")
    if args.input_per_million is not None:
        if min(args.input_per_million, args.output_per_million) < 0:
            parser.error("Rates cannot be negative")
        complete = [r for r in rows if r["input_tokens"] is not None and r["output_tokens"] is not None]
        estimate = sum(r["input_tokens"] * args.input_per_million + r["output_tokens"] * args.output_per_million for r in complete) / 1_000_000
        report["token_cost_estimate"] = {"usd": estimate, "covered_trials": len(complete), "total_trials": len(rows),
            "assumption": "All input billed at uncached rate; excludes sandbox/hosting costs.",
            "projected_usd": estimate / len(complete) * args.project_runs if complete and args.project_runs else None}
    with (args.jobs / "trials.csv").open("w", newline="", encoding="utf8") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (args.jobs / "summary.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    (args.jobs / "paired.json").write_text(json.dumps(paired(rows), indent=2), encoding="utf8")
    print(json.dumps(report, indent=2))
