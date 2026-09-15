"""Exercise concurrent requests against the real worker handlers without ML weights."""
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch

# cgi is only used by audio uploads, not these lifecycle handlers (Python 3.13+).
if importlib.util.find_spec("cgi") is None:
    sys.modules["cgi"] = types.ModuleType("cgi")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server/voice/python"))
import worker


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        worker._tts_model = None
        worker._loaded_tts_model_id = None
        self.responses = []

    def handler(self, read_event=None):
        handler = object.__new__(worker.VoiceWorkerHandler)
        def read():
            if read_event:
                read_event.set()
            return {"kind": "tts", "modelId": "test-model"}
        handler._read_json_body = read
        return handler

    def reply(self, handler, status, payload):
        self.responses.append((status, payload))

    def test_overlapping_loads_initialize_once(self):
        loading = threading.Event()
        release = threading.Event()
        second_read = threading.Event()
        calls = []
        def load(*args):
            calls.append(args)
            loading.set()
            if not release.wait(3):
                raise RuntimeError("test load timed out")
            worker._tts_model = object()
            worker._loaded_tts_model_id = "test-model"
        with patch.object(worker, "_load_tts_model", load), \
             patch.object(worker, "_unload_tts"), \
             patch.object(worker, "_json_response", self.reply):
            first = threading.Thread(target=self.handler()._handle_models_load)
            second = threading.Thread(target=self.handler(second_read)._handle_models_load)
            first.start()
            try:
                self.assertTrue(loading.wait(2))
                second.start()
                self.assertTrue(second_read.wait(2))
            finally:
                release.set()
                first.join(3)
                if second.ident is not None:
                    second.join(3)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(len(calls), 1)
            self.assertEqual([status for status, _ in self.responses], [200, 200])
            self.assertTrue(any(payload.get("alreadyLoaded") for _, payload in self.responses))

    def test_unload_waits_for_inference(self):
        read = threading.Event()
        with patch.object(worker, "_unload_tts") as unload, \
             patch.object(worker, "_json_response", self.reply):
            with worker._gpu_inference_lock:
                thread = threading.Thread(target=self.handler(read)._handle_models_unload)
                thread.start()
                self.assertTrue(read.wait(2))
                unload.assert_not_called()
            thread.join(3)
            self.assertFalse(thread.is_alive())
            unload.assert_called_once()


if __name__ == "__main__":
    unittest.main()
