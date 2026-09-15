"""Keep optional compilation from becoming a requirement for speech."""

import os
import warnings


def tts_compile_enabled() -> bool:
    # Compilation adds cold-start latency and requires a working compiler stack.
    if os.environ.get("MINNOW_TTS_USE_COMPILE", "false").strip().lower() not in (
        "1", "true", "yes",
    ):
        return False
    try:
        from torch.utils._triton import has_triton
        import torch._dynamo as dynamo

        if not has_triton():
            warnings.warn("TTS compilation unavailable; using eager inference.")
            return False
        # torch.compile is lazy: backend errors can surface during synthesis,
        # outside the model-load try/except. Let Dynamo use eager in that case.
        dynamo.config.suppress_errors = True
        return True
    except Exception as error:
        warnings.warn(f"TTS compilation unavailable; using eager inference: {error}")
        return False
