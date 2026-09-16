import asyncio
import base64
import json
import io
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from evals.harness.agent import MinnowAgent, MinnowOptions, ROOT, provider_headers
from evals.harness.manage import select_tasks
from evals.harness.report import summarize, collect, paired
from evals.harness import gui
from harbor.models.agent.context import AgentContext


class Reports(unittest.TestCase):
    def test_only_verifier_reward_counts_and_pairing_keeps_attempt_denominators(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for i, (profile, reward, error) in enumerate([("build", 1, None), ("minimal", 0, None), ("minimal", None, {"exception_type": "SetupError"})]):
                trial = root / str(i)
                trial.mkdir()
                (trial / "result.json").write_text(json.dumps({
                    "task_name": "fixture", "trial_name": str(i),
                    "config": {"agent": {"kwargs": {"profile": profile}}},
                    "agent_result": {"metadata": {"outcome": "pass"}},
                    "verifier_result": {"rewards": {"reward": reward}}, "exception_info": error,
                }))
            rows = collect(root)
            self.assertEqual(sum(row["passed"] for row in rows), 1)
            self.assertEqual(paired(rows)[0]["attempts"], {"build": 1, "minimal": 2})
            self.assertEqual(paired(rows)[0]["difference"], 1)

    def test_errors_remain_in_denominator_and_unknown_cost_is_not_zero(self):
        rows = [dict(profile="build", passed=True, status="graded", cost_usd=1),
                dict(profile="build", passed=False, status="error", cost_usd=None)]
        result = summarize(rows)["build"]
        self.assertEqual(result["pass_rate_all_trials"], .5)
        self.assertEqual(result["errors"], 1)
        self.assertIsNone(result["total_cost_usd"])

    def test_selection_is_deterministic(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ["c", "a", "b"]:
                (root / name).mkdir()
                (root / name / "task.toml").write_text("")
                (root / name / "instruction.md").write_text("test")
            self.assertEqual(select_tasks(root, 2, "seed"), select_tasks(root, 2, "seed"))
            with self.assertRaises(ValueError):
                select_tasks(root, 4, "seed")


class Adapter(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_runs_real_file_tool_and_collects_usage(self):
        with tempfile.TemporaryDirectory(prefix="minnow-harness-") as folder:
            root = Path(folder)
            workspace = root / "workspace"
            workspace.mkdir()
            target = workspace / "answer.txt"
            requests = []
            request_headers = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(body)
                    request_headers.append(self.headers.get("X-Eval-Fixture"))
                    delta = {"content": "Done."}
                    finish = "stop"
                    if len(requests) == 1:
                        delta = {"tool_calls": [{"index": 0, "id": "save-1", "type": "function",
                            "function": {"name": "save_file", "arguments": json.dumps({"path": str(target), "content": "verified"})}}]}
                        finish = "tool_calls"
                    data = "data: " + json.dumps({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}}) + "\n\ndata: [DONE]\n\n"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(data.encode())

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            class Environment:
                async def exec(self, command, **kwargs):
                    encoded = command.split()[-1].strip("'")
                    # Preserve the adapter protocol, but execute in an owned temporary
                    # directory for this offline smoke test. No task shell is involved.
                    value = json.loads(base64.b64decode(encoded))
                    assert value["workspace"] == str(workspace)
                    process = await asyncio.create_subprocess_exec("node", "evals/harness/tool-worker.mjs", encoded,
                        cwd=ROOT, env={**os.environ, "MINNOW_HOME": str(root / "home")},
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    stdout, stderr = await process.communicate()
                    return SimpleNamespace(return_code=process.returncode, stdout=stdout.decode(), stderr=stderr.decode())

            runtime = root / "runtime.tar.gz"
            runtime.write_bytes(b"test-runtime")
            agent = MinnowAgent(logs_dir=root / "logs", model_name="fake", runtime=runtime,
                                workspace=str(workspace), timeout_seconds=30, max_steps=3)
            context = AgentContext()
            try:
                with patch.dict(os.environ, {"MINNOW_EVAL_API_URL": f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                                            "MINNOW_EVAL_HEADERS": '{"X-Eval-Fixture":"private-test-header"}', "MINNOW_EVAL_API_KEY": ""}):
                    await agent.run("Write answer.txt containing verified.", Environment(), context)
                self.assertEqual(target.read_text(), "verified")
                self.assertEqual(len(requests), 2)
                self.assertEqual(request_headers, ["private-test-header", "private-test-header"])
                self.assertNotIn("private-test-header", (root / "logs/manifest.json").read_text())
                self.assertEqual(context.n_input_tokens, 40)
                self.assertEqual(context.metadata["outcome"], "no_report")
                self.assertIsNone(json.loads((root / "logs/minnow-result.json").read_text())["reward"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class SettingsCoordinator(unittest.TestCase):
    def test_opencode_requests_receive_per_trial_routing_identity(self):
        headers = provider_headers(
            {"Authorization": "Bearer secret"},
            "https://opencode.ai/zen/go/v1/chat/completions",
            "trial-123",
        )
        self.assertEqual(headers["x-opencode-session"], "trial-123")
        self.assertNotIn(
            "x-opencode-session",
            provider_headers({}, "https://example.com/v1/chat/completions", "trial-123"),
        )

    def test_custom_agent_options_are_declared_and_validated(self):
        self.assertIs(MinnowAgent.options_model, MinnowOptions)
        MinnowAgent.preflight({"profile": "minimal", "max_steps": 3})
        with self.assertRaises(ValueError):
            MinnowAgent.preflight({"max_steps": 0})
        with self.assertRaises(ValueError):
            MinnowAgent.preflight({"unknown_option": True})

    def test_runs_both_profiles_in_isolated_jobs_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "evals/harness/artifacts/gui-test"
            def prepare(args):
                folder.mkdir(parents=True)
                for profile in ("build", "minimal"):
                    (folder / f"{profile}.json").write_text(json.dumps({"jobs_dir": "wrong"}))
            calls = []
            def execute(command, **kwargs):
                calls.append(command)
                (folder / "jobs").mkdir(exist_ok=True)
                return SimpleNamespace(returncode=1 if len(calls) == 1 else 0)
            with patch.object(gui, "ROOT", root), patch.object(gui, "campaign", prepare), \
                    patch.object(gui.sys, "stdin", io.StringIO('{"name":"gui-test"}')), \
                    patch.object(gui.subprocess, "run", execute):
                self.assertEqual(gui.main(), 1)
            self.assertEqual(len(calls), 3)
            self.assertIn("harbor.cli.main", calls[0])
            self.assertTrue(calls[1][-1].endswith("minimal.json"))
            self.assertEqual(calls[2][-1], str(folder / "jobs"))
            self.assertEqual(json.loads((folder / "build.json").read_text())["jobs_dir"], str(folder / "jobs"))


if __name__ == "__main__":
    unittest.main()
