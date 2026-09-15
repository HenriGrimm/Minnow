"""Exercise the actual compile policy without installing torch or a GPU."""
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / "server/voice/python/tts_optimizations.py"
spec = importlib.util.spec_from_file_location("tts_optimizations", source)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class CompilePolicyTest(unittest.TestCase):
    def test_default_and_false_flags_need_no_torch(self):
        with patch.dict(sys.modules, {"torch": None}):
            for value in (None, "false", "0", "no", "invalid"):
                with patch.dict(os.environ, {}, clear=True):
                    if value is not None:
                        os.environ["MINNOW_TTS_USE_COMPILE"] = value
                    self.assertFalse(policy.tts_compile_enabled())

    def test_missing_torch_or_triton_falls_back_even_with_opt_in(self):
        with patch.dict(os.environ, {"MINNOW_TTS_USE_COMPILE": "true"}):
            with patch.dict(sys.modules, {"torch": None}):
                with self.assertWarnsRegex(UserWarning, "eager inference"):
                    self.assertFalse(policy.tts_compile_enabled())

    def test_supported_compile_enables_lazy_failure_fallback(self):
        config = SimpleNamespace(suppress_errors=False)
        dynamo = SimpleNamespace(config=config)
        modules = {"torch": SimpleNamespace(_dynamo=dynamo),
                   "torch._dynamo": dynamo,
                   "torch.utils": SimpleNamespace(),
                   "torch.utils._triton": SimpleNamespace(has_triton=lambda: True)}
        with patch.dict(sys.modules, modules):
            with patch.dict(os.environ, {"MINNOW_TTS_USE_COMPILE": " TRUE "}):
                self.assertTrue(policy.tts_compile_enabled())
                self.assertTrue(config.suppress_errors)

    def test_unusable_triton_falls_back(self):
        dynamo = SimpleNamespace(config=SimpleNamespace(suppress_errors=False))
        modules = {"torch": SimpleNamespace(_dynamo=dynamo), "torch._dynamo": dynamo,
                   "torch.utils": SimpleNamespace(),
                   "torch.utils._triton": SimpleNamespace(has_triton=lambda: False)}
        with patch.dict(sys.modules, modules):
            with patch.dict(os.environ, {"MINNOW_TTS_USE_COMPILE": "1"}):
                with self.assertWarnsRegex(UserWarning, "eager inference"):
                    self.assertFalse(policy.tts_compile_enabled())


if __name__ == "__main__":
    unittest.main()
