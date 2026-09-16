"""Harbor external agent: host model transport, production tools inside the sandbox."""
import asyncio
import base64
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import httpx
from harbor.agents.base import BaseAgent
from evals.harness.provenance import source_digest, file_digest

ROOT = Path(__file__).resolve().parents[2]


class MinnowAgent(BaseAgent):
    def __init__(self, *args, profile="build", runtime=None, max_steps=500,
                 context_window=131072, max_tokens=16384, timeout_seconds=1800,
                 reasoning_effort=None, temperature=1.0, top_p=0.95,
                 workspace=None, **kwargs):
        super().__init__(*args, **kwargs)
        if profile not in ("build", "minimal"):
            raise ValueError("profile must be build or minimal")
        self.runtime = Path(runtime or ROOT / "evals/harness/artifacts/minnow-runtime.tar.gz").resolve()
        self.config = dict(profile=profile, maxSteps=int(max_steps), contextWindow=int(context_window),
                           maxTokens=int(max_tokens), timeoutSeconds=int(timeout_seconds))
        if any(v <= 0 for v in self.config.values() if isinstance(v, int)):
            raise ValueError("Budgets must be positive")
        self.workspace = workspace
        self.sampler = {"temperature": float(temperature), "top_p": float(top_p)}
        if reasoning_effort is not None:
            self.sampler["reasoning_effort"] = reasoning_effort

    @staticmethod
    def name():
        return "minnow"

    def version(self):
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()

    async def setup(self, environment):
        if not self.runtime.is_file():
            raise FileNotFoundError("Build the sandbox runtime first: npm run eval:harness:runtime")
        provenance = json.loads(self.runtime.with_name(self.runtime.name + ".json").read_text(encoding="utf8"))
        if provenance["source_sha256"] != source_digest(ROOT) or provenance["runtime_sha256"] != file_digest(self.runtime):
            raise RuntimeError("Runtime artifact is stale or changed; run npm run eval:harness:runtime")
        # No model credentials or host configuration are copied into the task.
        await environment.upload_file(self.runtime, "/tmp/minnow-runtime.tar.gz")
        out = await environment.exec(command="mkdir -p /opt/minnow-eval && tar -xzf /tmp/minnow-runtime.tar.gz -C /opt/minnow-eval && /opt/minnow-eval/node --version", timeout_sec=180, user="root")
        if out.return_code:
            raise RuntimeError(f"Minnow runtime extraction failed: {out.stderr}")
        detected = await environment.exec(command="pwd", timeout_sec=10)
        self.workspace = self.workspace or detected.stdout.strip()
        if not self.workspace or not self.workspace.startswith("/"):
            raise ValueError("Cannot determine task working directory; set workspace explicitly")

    async def run(self, instruction, environment, context):
        endpoint = os.environ.get("MINNOW_EVAL_API_URL")
        if not endpoint or not self.model_name:
            raise ValueError("Set MINNOW_EVAL_API_URL (complete chat/completions URL) and --model")
        headers = {"Content-Type": "application/json"}
        headers.update(json.loads(os.environ.get("MINNOW_EVAL_HEADERS", "{}")))
        if key := os.environ.get("MINNOW_EVAL_API_KEY"):
            headers["Authorization"] = f"Bearer {key}"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        config = {**self.config, "model": self.model_name, "workspace": self.workspace,
                  "instruction": instruction, "sampler": self.sampler}
        runtime_hash = file_digest(self.runtime)
        manifest = {"revision": self.version(), "config": config,
                    "runtime_sha256": runtime_hash,
                    "source_sha256": source_digest(ROOT),
                    "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
                    "transport": "openai-chat-completions; buffered SSE", "adapter_version": 1}
        (self.logs_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf8")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is required on the evaluation host")
        # Fresh environment prevents accidental access to the user's Minnow home.
        child_env = {**os.environ, "MINNOW_HOME": str(self.logs_dir / "coordinator-home")}
        child_env.pop("MINNOW_EVAL_API_KEY", None)
        child_env.pop("MINNOW_EVAL_HEADERS", None)
        errlog = (self.logs_dir / "runner-stderr.log").open("wb")
        process = await asyncio.create_subprocess_exec(node, "--import", "tsx", "evals/harness/bridge.mjs",
            cwd=ROOT, env=child_env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=errlog, limit=32 * 1024 * 1024)
        lock = asyncio.Lock()
        async def send(value):
            async with lock:
                process.stdin.write((json.dumps(value) + "\n").encode())
                await process.stdin.drain()
        events = (self.logs_dir / "events.jsonl").open("w", encoding="utf8")
        tasks = set()
        result = None
        try:
            async with httpx.AsyncClient(timeout=self.config["timeoutSeconds"]) as client:
                async def handle(message):
                    try:
                        if message["kind"] == "completion":
                            body = message["payload"]
                            body["stream"] = True
                            body["stream_options"] = {"include_usage": True}
                            events.write(json.dumps({"type": "request", "body": body}) + "\n")
                            events.flush()
                            response = await client.post(endpoint, headers=headers, json=body)
                            value = {"status": response.status_code, "text": response.text,
                                     "contentType": response.headers.get("content-type", "text/event-stream")}
                        else:
                            payload = {**message["payload"], "workspace": self.workspace,
                                       "profile": self.config["profile"]}
                            encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                            command = ("MINNOW_HOME=/tmp/minnow-eval-home /opt/minnow-eval/node "
                                       "/opt/minnow-eval/minnow/evals/harness/tool-worker.mjs " + shlex.quote(encoded))
                            out = await environment.exec(command=command, timeout_sec=self.config["timeoutSeconds"])
                            lines = [line for line in out.stdout.splitlines() if line.startswith("MINNOW_RESULT:")]
                            if out.return_code or not lines:
                                raise RuntimeError(f"Sandbox tool worker failed (exit {out.return_code}): {out.stderr[-2000:]}")
                            value = json.loads(lines[-1].removeprefix("MINNOW_RESULT:"))
                        await send({"id": message["id"], "result": value})
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        await send({"id": message["id"], "error": str(exc)})

                await send({"kind": "start", "config": config})
                async with asyncio.timeout(self.config["timeoutSeconds"] + 30):
                    while line := await process.stdout.readline():
                        message = json.loads(line)
                        if message["kind"] in ("completion", "tool"):
                            task = asyncio.create_task(handle(message))
                            tasks.add(task)
                            task.add_done_callback(tasks.discard)
                        elif message["kind"] == "event":
                            event = message["event"]
                            events.write(json.dumps(event) + "\n")
                            events.flush()
                            if event["type"] == "round_end" and event.get("usage"):
                                usage = event["usage"]
                                context.n_input_tokens = (context.n_input_tokens or 0) + usage.get("prompt_tokens", 0)
                                context.n_output_tokens = (context.n_output_tokens or 0) + usage.get("completion_tokens", 0)
                        elif message["kind"] == "result":
                            result = message["result"]
                            (self.logs_dir / "minnow-result.json").write_text(json.dumps(result, indent=2), encoding="utf8")
                            context.metadata = {"minnow": result["metrics"], "outcome": result["result"]["outcome"]}
                            break
                        elif message["kind"] == "fatal":
                            raise RuntimeError(message["error"])
                if result is None:
                    raise RuntimeError("Minnow exited without a result; inspect runner-stderr.log")
                if result["result"]["outcome"] in ("crashed", "timeout"):
                    raise RuntimeError(f"Minnow run failed: {result['result']}")
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if process.returncode is None:
                process.kill()
            await process.wait()
            events.close()
            errlog.close()
