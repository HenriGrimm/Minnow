#!/usr/bin/env python3
"""
Minnow voice worker — local Whisper STT + Qwen3-TTS inference.
"""

from __future__ import annotations

import argparse
import base64
import cgi
import io
import json
import os
import tempfile
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from tts_optimizations import tts_compile_enabled

# Lazy-loaded ML stack — import only when inference routes are called.
_fw_model: Any = None
_stt_pipeline: Any = None
_tts_model: Any = None
_loaded_stt_model_id: str | None = None
_loaded_tts_model_id: str | None = None
_loaded_tts_mode: str | None = None
_tts_speakers: list[str] = []
_tts_languages: list[str] = []

# Serialize inference and model lifecycle. Transformers loading changes process-wide
# initialization hooks; concurrent loads can leave parameters on the meta device.
_gpu_inference_lock = threading.Lock()


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _flash_attn_available() -> bool:
    try:
        import flash_attn  # noqa: F401

        return True
    except Exception:
        return False


def _resolve_device(config: dict[str, Any]) -> str:
    device_pref = str(config.get("device", "auto") or "auto")
    if device_pref == "cpu":
        return "cpu"
    if device_pref == "cuda":
        return "cuda:0" if _cuda_available() else "cpu"
    return "cuda:0" if _cuda_available() else "cpu"


def _resolve_dtype(config: dict[str, Any], device: str):
    import torch

    compute = str(config.get("computeType", "auto") or "auto")
    if device.startswith("cpu"):
        return torch.float32
    if compute == "float16":
        return torch.float16
    if compute == "bfloat16":
        return torch.bfloat16
    if compute == "float32":
        return torch.float32
    return torch.float16 if _cuda_available() else torch.float32


def _resolve_tts_device_map(config: dict[str, Any]) -> str:
    device_map = str(config.get("deviceMap", "auto") or "auto")
    if device_map == "cpu":
        return "cpu"
    if device_map == "cuda:0":
        return "cuda:0" if _cuda_available() else "cpu"
    return "cuda:0" if _cuda_available() else "cpu"


def _resolve_tts_dtype(config: dict[str, Any]):
    import torch

    dtype_pref = str(config.get("dtype", "auto") or "auto")
    if dtype_pref == "float16":
        return torch.float16
    if dtype_pref == "bfloat16":
        return torch.bfloat16
    if dtype_pref == "float32":
        return torch.float32
    return torch.bfloat16 if _cuda_available() else torch.float32


def _stt_is_loaded() -> bool:
    return _fw_model is not None or _stt_pipeline is not None


def _tts_is_loaded() -> bool:
    return _tts_model is not None


def _legacy_capabilities() -> dict[str, Any]:
    """Backward-compat fields when only one model kind was resident."""
    stt_loaded = _stt_is_loaded()
    tts_loaded = _tts_is_loaded()
    model_loaded = stt_loaded or tts_loaded
    if stt_loaded:
        loaded_kind = "stt"
        loaded_model_id = _loaded_stt_model_id
    elif tts_loaded:
        loaded_kind = "tts"
        loaded_model_id = _loaded_tts_model_id
    else:
        loaded_kind = None
        loaded_model_id = None
    return {
        "modelLoaded": model_loaded,
        "loadedModelId": loaded_model_id,
        "loadedKind": loaded_kind,
        "loadedMode": _loaded_tts_mode,
    }


def _maybe_empty_cuda_cache() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _unload_stt() -> None:
    global _fw_model, _stt_pipeline, _loaded_stt_model_id
    _fw_model = None
    _stt_pipeline = None
    _loaded_stt_model_id = None
    _maybe_empty_cuda_cache()


def _unload_tts() -> None:
    global _tts_model, _loaded_tts_model_id, _loaded_tts_mode
    global _tts_speakers, _tts_languages
    _tts_model = None
    _loaded_tts_model_id = None
    _loaded_tts_mode = None
    _tts_speakers = []
    _tts_languages = []
    _maybe_empty_cuda_cache()


def _resolve_fw_compute_type(config: dict[str, Any], device: str) -> str:
    compute = str(config.get("computeType", "auto") or "auto")
    if compute == "float16":
        return "float16"
    if compute == "float32":
        return "float32"
    if compute == "bfloat16":
        return "float16"
    return "float16" if device == "cuda" else "int8"


def _is_faster_whisper_model_dir(model_path: str) -> bool:
    """True when the directory is a CTranslate2 snapshot (model.bin), not HF transformers."""
    return bool(model_path) and os.path.isfile(os.path.join(model_path, "model.bin"))


def _resolve_fw_model_source(model_id: str, model_path: str) -> str:
    # Local HF snapshots (model.safetensors / pytorch_model.bin) cannot be loaded by faster-whisper.
    if model_path and os.path.isdir(model_path) and _is_faster_whisper_model_dir(model_path):
        return model_path
    lowered = model_id.lower()
    for size in ("large-v3", "large-v2", "large", "medium", "small", "base", "tiny"):
        if size in lowered:
            return size
    return model_id


def _load_stt_model(model_id: str, model_path: str, config: dict[str, Any]) -> None:
    global _fw_model, _stt_pipeline, _loaded_stt_model_id

    device_pref = _resolve_device(config)
    device = "cuda" if device_pref.startswith("cuda") else "cpu"
    compute_type = _resolve_fw_compute_type(config, device)
    source = _resolve_fw_model_source(model_id, model_path)

    try:
        from faster_whisper import WhisperModel

        _fw_model = WhisperModel(source, device=device, compute_type=compute_type)
        _stt_pipeline = None
        _loaded_stt_model_id = model_id
        return
    except ImportError as err:
        raise RuntimeError(
            "faster-whisper is not installed in the voice runtime. Repair from Models → Voice."
        ) from err


def _load_stt_model_transformers_fallback(model_id: str, model_path: str, config: dict[str, Any]) -> None:
    """Optional HF transformers fallback when faster-whisper is unavailable."""
    global _stt_pipeline, _fw_model, _loaded_stt_model_id

    from transformers import pipeline

    device = _resolve_device(config)
    torch_dtype = _resolve_dtype(config, device)
    attn = str(config.get("attnImplementation", "auto") or "auto")
    model_kwargs: dict[str, Any] = {
        "torch_dtype": torch_dtype,
        "low_cpu_mem_usage": bool(config.get("lowCpuMemUsage", True)),
        "use_safetensors": bool(config.get("useSafetensors", True)),
    }
    if attn != "auto":
        model_kwargs["attn_implementation"] = attn

    source = model_path if model_path else model_id
    _stt_pipeline = pipeline(
        "automatic-speech-recognition",
        model=source,
        device=0 if device.startswith("cuda") else -1,
        model_kwargs=model_kwargs,
    )
    _fw_model = None
    _loaded_stt_model_id = model_id


def _load_tts_model(
    model_id: str,
    model_path: str,
    tokenizer_path: str,
    config: dict[str, Any],
) -> None:
    global _tts_model, _loaded_tts_model_id, _loaded_tts_mode
    global _tts_speakers, _tts_languages

    try:
        from qwen_tts import Qwen3TTSModel
    except ImportError as err:
        raise RuntimeError(
            "qwen-tts is not installed in the voice runtime. Repair from Models → Voice."
        ) from err

    import torch

    device_map = _resolve_tts_device_map(config)
    dtype = _resolve_tts_dtype(config)
    attn = str(config.get("attnImplementation", "auto") or "auto")
    load_kwargs: dict[str, Any] = {
        "device_map": device_map,
        "dtype": dtype,
    }
    if attn != "auto":
        load_kwargs["attn_implementation"] = attn

    source = model_path if model_path else model_id
    _tts_model = Qwen3TTSModel.from_pretrained(source, **load_kwargs)

    mode = str(config.get("mode", "custom_voice") or "custom_voice")
    _loaded_tts_model_id = model_id
    _loaded_tts_mode = mode

    _tts_speakers = []
    _tts_languages = []
    try:
        if hasattr(_tts_model, "get_supported_speakers"):
            _tts_speakers = list(_tts_model.get_supported_speakers() or [])
    except Exception:
        _tts_speakers = []
    try:
        if hasattr(_tts_model, "get_supported_languages"):
            _tts_languages = list(_tts_model.get_supported_languages() or [])
    except Exception:
        _tts_languages = []

    # Streaming fork exposes torch.compile + CUDA graph warmup for decode windows.
    if hasattr(_tts_model, "enable_streaming_optimizations"):
        use_compile = tts_compile_enabled()
        decode_window = 80
        streaming_cfg = config.get("streaming")
        if isinstance(streaming_cfg, dict) and streaming_cfg.get("decodeWindowFrames") is not None:
            decode_window = int(streaming_cfg["decodeWindowFrames"])
        try:
            _tts_model.enable_streaming_optimizations(
                decode_window_frames=decode_window,
                use_compile=use_compile,
                use_cuda_graphs=use_compile,
                compile_mode="reduce-overhead",
            )
        except Exception:
            # Optional optimization — model load should still succeed without it.
            pass


def _parse_multipart(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    content_type = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in content_type:
        length = int(handler.headers.get("Content-Length", "0") or "0")
        raw = handler.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}
        audio_b64 = payload.get("audioBase64")
        if isinstance(audio_b64, str) and audio_b64:
            return {
                "audio": base64.b64decode(audio_b64),
                "mime": str(payload.get("mime", "audio/wav")),
                "config": payload.get("config") if isinstance(payload.get("config"), dict) else {},
            }
        return {}

    form = cgi.FieldStorage(
        fp=handler.rfile,
        headers=handler.headers,
        environ={
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": content_type,
        },
    )

    audio_bytes = b""
    mime = "audio/webm"
    config: dict[str, Any] = {}

    if "file" in form:
        file_item = form["file"]
        audio_bytes = file_item.file.read() if hasattr(file_item, "file") else b""
        mime = getattr(file_item, "type", None) or mime

    if "config" in form:
        raw_config = form.getfirst("config")
        if isinstance(raw_config, str) and raw_config.strip():
            try:
                parsed = json.loads(raw_config)
                if isinstance(parsed, dict):
                    config = parsed
            except json.JSONDecodeError:
                config = {}

    return {"audio": audio_bytes, "mime": mime, "config": config}


def _suffix_for_mime(mime: str) -> str:
    base = str(mime or "").split(";", 1)[0].strip().lower()
    mapping = {
        "audio/webm": ".webm",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/wave": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".m4a",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
    }
    return mapping.get(base, ".bin")


def _decode_with_ffmpeg(input_path: str) -> tuple[Any, int]:
    import subprocess

    import imageio_ffmpeg
    import numpy as np
    import soundfile as sf

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as out:
        output_path = out.name

    try:
        completed = subprocess.run(
            [
                ffmpeg_exe,
                "-y",
                "-i",
                input_path,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                output_path,
            ],
            check=False,
            capture_output=True,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail or f"ffmpeg exited {completed.returncode}")
        data, sample_rate = sf.read(output_path)
        return np.asarray(data, dtype=np.float32), int(sample_rate)
    finally:
        if os.path.isfile(output_path):
            os.unlink(output_path)


def _decode_audio(audio_bytes: bytes, mime: str = "audio/webm") -> tuple[Any, int]:
    import numpy as np

    suffix = _suffix_for_mime(mime)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        input_path = tmp.name

    decode_error: Exception | None = None
    try:
        if suffix in (".wav", ".flac", ".ogg"):
            import soundfile as sf

            data, sample_rate = sf.read(input_path)
            return np.asarray(data, dtype=np.float32), int(sample_rate)

        try:
            import torchaudio

            waveform, sample_rate = torchaudio.load(input_path)
            if waveform.shape[0] > 1:
                waveform = waveform.mean(dim=0, keepdim=True)
            data = waveform.squeeze(0).detach().cpu().numpy().astype(np.float32)
            return data, int(sample_rate)
        except Exception as err:
            decode_error = err

        return _decode_with_ffmpeg(input_path)
    except Exception as err:
        if decode_error is not None:
            raise RuntimeError(
                f"Could not decode audio ({mime or 'unknown'}). "
                "Run Repair in Models → Voice to install ffmpeg support, or send WAV audio."
            ) from decode_error
        raise
    finally:
        if os.path.isfile(input_path):
            os.unlink(input_path)


def _transcribe_pcm_faster_whisper(pcm_int16: Any, sample_rate: int, config: dict[str, Any]) -> str:
    if _fw_model is None:
        raise RuntimeError("STT model is not loaded")

    import numpy as np

    audio = np.frombuffer(pcm_int16, dtype=np.int16).astype(np.float32) / 32768.0
    if sample_rate != 16000:
        # Resample is out of scope for v1 — client sends 16 kHz PCM.
        pass

    generate_kwargs: dict[str, Any] = {"vad_filter": True}
    language = str(config.get("language", "") or "").strip()
    if language:
        generate_kwargs["language"] = language
    task = config.get("task")
    if task in ("transcribe", "translate"):
        generate_kwargs["task"] = task

    segments, _info = _fw_model.transcribe(audio, **generate_kwargs)
    parts = [seg.text.strip() for seg in segments if seg.text.strip()]
    return " ".join(parts).strip()


def _transcribe_audio(audio_bytes: bytes, config: dict[str, Any], mime: str = "audio/webm") -> str:
    if _fw_model is not None:
        data, sample_rate = _decode_audio(audio_bytes, mime)
        import numpy as np

        pcm = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
        return _transcribe_pcm_faster_whisper(pcm.tobytes(), sample_rate, config)

    if _stt_pipeline is None:
        raise RuntimeError("STT model is not loaded")

    data, sample_rate = _decode_audio(audio_bytes, mime)

    generate_kwargs: dict[str, Any] = {}
    language = str(config.get("language", "") or "").strip()
    if language:
        generate_kwargs["language"] = language
    task = config.get("task")
    if task in ("transcribe", "translate"):
        generate_kwargs["task"] = task

    if bool(config.get("returnTimestamps", False)):
        granularity = config.get("timestampGranularity", "segment")
        generate_kwargs["return_timestamps"] = (
            granularity if granularity in ("word", "segment") else "segment"
        )

    chunk_length = int(config.get("chunkLengthSeconds", 30) or 30)
    batch_size = int(config.get("batchSize", 1) or 1)

    result = _stt_pipeline(
        {"array": data, "sampling_rate": sample_rate},
        chunk_length_s=chunk_length,
        batch_size=batch_size,
        generate_kwargs=generate_kwargs,
    )

    if isinstance(result, dict):
        text = result.get("text", "")
        return str(text).strip()
    return str(result).strip()


def _normalize_language(language: str) -> str:
    lang = str(language or "").strip()
    if not lang or lang.lower() == "auto":
        return "Auto"
    return lang


def _generation_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    generation = config.get("generation") if isinstance(config.get("generation"), dict) else {}
    kwargs: dict[str, Any] = {}
    for key in ("maxNewTokens", "topP", "topK", "temperature", "repetitionPenalty"):
        if key in generation:
            snake = "".join(
                ["_" + c.lower() if c.isupper() else c for c in key]
            ).lstrip("_")
            kwargs[snake] = generation[key]
    return kwargs


def _wav_bytes_from_numpy(wavs: Any, sample_rate: int) -> bytes:
    import numpy as np

    audio = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _resolve_ref_audio(ref_audio_path: str) -> str:
    if not ref_audio_path:
        raise ValueError("Reference audio path is required for voice clone")
    if os.path.isfile(ref_audio_path):
        return ref_audio_path
    home = os.path.expanduser("~/.minnow/voice/refs")
    candidate = os.path.join(home, os.path.basename(ref_audio_path))
    if os.path.isfile(candidate):
        return candidate
    raise ValueError(f"Reference audio not found: {ref_audio_path}")


def _synthesize_tts(text: str, config: dict[str, Any]) -> tuple[bytes, str]:
    if _tts_model is None:
        raise RuntimeError("TTS model is not loaded")

    mode = str(config.get("mode", _loaded_tts_mode or "custom_voice") or "custom_voice")
    gen_kwargs = _generation_kwargs(config)

    if mode == "custom_voice":
        custom = config.get("customVoice") if isinstance(config.get("customVoice"), dict) else {}
        speaker = str(custom.get("speaker", "Ryan") or "Ryan")
        language = _normalize_language(str(custom.get("language", "Auto") or "Auto"))
        instruct = str(custom.get("instruct", "") or "").strip()
        call_kwargs: dict[str, Any] = {
            "text": text,
            "language": language,
            "speaker": speaker,
            **gen_kwargs,
        }
        if instruct:
            call_kwargs["instruct"] = instruct
        wavs, sr = _tts_model.generate_custom_voice(**call_kwargs)
    elif mode == "voice_design":
        design = config.get("voiceDesign") if isinstance(config.get("voiceDesign"), dict) else {}
        language = _normalize_language(str(design.get("language", "Auto") or "Auto"))
        instruct = str(design.get("instruct", "") or "").strip()
        if not instruct:
            raise ValueError("Voice design instruct is required")
        wavs, sr = _tts_model.generate_voice_design(
            text=text,
            language=language,
            instruct=instruct,
            **gen_kwargs,
        )
    elif mode == "voice_clone":
        clone = config.get("voiceClone") if isinstance(config.get("voiceClone"), dict) else {}
        language = _normalize_language(str(clone.get("language", "Auto") or "Auto"))
        ref_text = str(clone.get("refText", "") or "").strip()
        ref_audio_path = _resolve_ref_audio(str(clone.get("refAudioPath", "") or ""))
        x_vector_only = bool(clone.get("xVectorOnlyMode", False))
        wavs, sr = _tts_model.generate_voice_clone(
            text=text,
            language=language,
            ref_audio=ref_audio_path,
            ref_text=ref_text,
            x_vector_only_mode=x_vector_only,
            **gen_kwargs,
        )
    else:
        raise ValueError(f"Unsupported TTS mode: {mode}")

    return _wav_bytes_from_numpy(wavs, sr), "audio/wav"


def _streaming_tuning(config: dict[str, Any]) -> dict[str, Any]:
    """Map `tts.local.streaming` config keys to qwen-tts stream_generate_* kwargs."""
    streaming = config.get("streaming") if isinstance(config.get("streaming"), dict) else {}
    generation = config.get("generation") if isinstance(config.get("generation"), dict) else {}
    repetition = streaming.get("repetitionPenalty")
    if repetition is None:
        repetition = generation.get("repetitionPenalty", 1.05)
    return {
        "emit_every_frames": int(streaming.get("emitEveryFrames", 8)),
        "decode_window_frames": int(streaming.get("decodeWindowFrames", 80)),
        "first_chunk_emit_every": int(streaming.get("firstChunkEmitEvery", 5)),
        "first_chunk_decode_window": int(streaming.get("firstChunkDecodeWindow", 48)),
        "overlap_samples": int(streaming.get("overlapSamples", 512)),
        "repetition_penalty": float(repetition),
    }


def _stream_method_name_for_mode(mode: str) -> str:
    return {
        "custom_voice": "stream_generate_custom_voice",
        "voice_design": "stream_generate_voice_design",
        "voice_clone": "stream_generate_voice_clone",
    }.get(mode, "")


def _streaming_unavailable_error(mode: str) -> RuntimeError:
    method_name = _stream_method_name_for_mode(mode) or "stream_generate_*"
    return RuntimeError(
        f"Streaming TTS API ({method_name}) is not available for mode {mode}. "
        "Repair from Models → Voice to install the qwen-tts streaming fork."
    )


def _iter_tts_stream_chunks(text: str, config: dict[str, Any]):
    """Yield (pcm_float32, sample_rate) from the loaded model's streaming generator."""
    if _tts_model is None:
        raise RuntimeError("TTS model is not loaded")

    mode = str(config.get("mode", _loaded_tts_mode or "custom_voice") or "custom_voice")
    method_name = _stream_method_name_for_mode(mode)
    if not method_name or not hasattr(_tts_model, method_name):
        raise _streaming_unavailable_error(mode)

    tuning = _streaming_tuning(config)
    gen_kwargs = _generation_kwargs(config)
    stream_method = getattr(_tts_model, method_name)

    if mode == "custom_voice":
        custom = config.get("customVoice") if isinstance(config.get("customVoice"), dict) else {}
        speaker = str(custom.get("speaker", "Ryan") or "Ryan")
        language = _normalize_language(str(custom.get("language", "Auto") or "Auto"))
        instruct = str(custom.get("instruct", "") or "").strip()
        call_kwargs: dict[str, Any] = {
            "text": text,
            "language": language,
            "speaker": speaker,
            **tuning,
            **gen_kwargs,
        }
        if instruct:
            call_kwargs["instruct"] = instruct
        yield from stream_method(**call_kwargs)
        return

    if mode == "voice_design":
        design = config.get("voiceDesign") if isinstance(config.get("voiceDesign"), dict) else {}
        language = _normalize_language(str(design.get("language", "Auto") or "Auto"))
        instruct = str(design.get("instruct", "") or "").strip()
        if not instruct:
            raise ValueError("Voice design instruct is required")
        yield from stream_method(
            text=text,
            language=language,
            instruct=instruct,
            **tuning,
            **gen_kwargs,
        )
        return

    if mode == "voice_clone":
        clone = config.get("voiceClone") if isinstance(config.get("voiceClone"), dict) else {}
        language = _normalize_language(str(clone.get("language", "Auto") or "Auto"))
        ref_text = str(clone.get("refText", "") or "").strip()
        ref_audio_path = _resolve_ref_audio(str(clone.get("refAudioPath", "") or ""))
        x_vector_only = bool(clone.get("xVectorOnlyMode", False))
        yield from stream_method(
            text=text,
            language=language,
            ref_audio=ref_audio_path,
            ref_text=ref_text,
            x_vector_only_mode=x_vector_only,
            **tuning,
            **gen_kwargs,
        )
        return

    raise ValueError(f"Unsupported TTS mode: {mode}")


class TtsStreamSession:
    """NDJSON text ops → SSE PCM chunks from qwen-tts stream_generate_* APIs."""

    def __init__(self, config: dict[str, Any], wfile: Any) -> None:
        self.config = config
        self.wfile = wfile
        self._line_buffer = bytearray()
        self._text_parts: list[str] = []
        self._frame_index = 0
        self._streamed = False
        self._start_time = time.monotonic()

    def _sse(self, event: str, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        self.wfile.write(b"data: ")
        self.wfile.write(body)
        self.wfile.write(b"\n\n")
        self.wfile.flush()

    def ingest(self, chunk: bytes) -> None:
        if not chunk:
            return
        self._line_buffer.extend(chunk)
        while b"\n" in self._line_buffer:
            line, remainder = self._line_buffer.split(b"\n", 1)
            self._line_buffer = bytearray(remainder)
            self._handle_line(line)

    def _handle_line(self, raw_line: bytes) -> None:
        line = raw_line.strip()
        if not line:
            return
        try:
            message = json.loads(line.decode("utf-8"))
        except json.JSONDecodeError as err:
            self._sse("error", {"message": f"Invalid NDJSON line: {err}"})
            return
        if not isinstance(message, dict):
            self._sse("error", {"message": "NDJSON message must be a JSON object"})
            return
        self._handle_message(message)

    def _handle_message(self, message: dict[str, Any]) -> None:
        op = str(message.get("op", "") or "")
        if op == "start":
            text = str(message.get("text", "") or "")
            if text:
                self._text_parts.append(text)
            return
        if op == "append":
            text = str(message.get("text", "") or "")
            if text:
                self._text_parts.append(text)
            return
        if op == "finish":
            self._run_stream()
            return
        self._sse("error", {"message": f"Unknown op: {op or '(missing)'}"})

    def _run_stream(self) -> None:
        if self._streamed:
            return
        self._streamed = True

        text = "".join(self._text_parts).strip()
        if not text:
            self._sse("error", {"message": "No text to synthesize"})
            return

        try:
            import numpy as np

            with _gpu_inference_lock:
                for pcm_chunk, sample_rate in _iter_tts_stream_chunks(text, self.config):
                    arr = np.asarray(pcm_chunk, dtype=np.float32)
                    if arr.ndim > 1:
                        arr = arr.reshape(-1)
                    arr = np.clip(arr, -1.0, 1.0)
                    pcm_int16 = (arr * 32767.0).astype(np.int16)
                    self._sse(
                        "chunk",
                        {
                            "pcmBase64": base64.b64encode(pcm_int16.tobytes()).decode("ascii"),
                            "sampleRate": int(sample_rate),
                            "frameIndex": self._frame_index,
                        },
                    )
                    self._frame_index += 1
            duration_ms = int((time.monotonic() - self._start_time) * 1000)
            self._sse("final", {"durationMs": duration_ms})
        except Exception as err:
            self._sse("error", {"message": str(err)})

    def finalize(self) -> None:
        if self._line_buffer.strip():
            self._handle_line(bytes(self._line_buffer))
            self._line_buffer.clear()
        if not self._streamed and self._text_parts:
            self._run_stream()


class SttStreamSession:
    """Incremental PCM → faster-whisper segment streaming at 16 kHz mono."""

    SAMPLE_RATE = 16000
    MIN_SPEECH_SAMPLES = int(0.4 * SAMPLE_RATE)
    SILENCE_SAMPLES = int(0.55 * SAMPLE_RATE)
    ENERGY_THRESHOLD = 0.012

    def __init__(self, config: dict[str, Any], wfile: Any) -> None:
        self.config = config
        self.wfile = wfile
        self.buffer = bytearray()
        self.speech_active = False
        self.silence_samples = 0
        self.speech_samples = 0
        self.committed: list[str] = []

    def _sse(self, event: str, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        self.wfile.write(b"data: ")
        self.wfile.write(body)
        self.wfile.write(b"\n\n")
        self.wfile.flush()

    def ingest(self, chunk: bytes) -> None:
        if not chunk:
            return
        self.buffer.extend(chunk)
        import numpy as np

        samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        if samples.size == 0:
            return
        energy = float(np.sqrt(np.mean(samples * samples)))
        if energy >= self.ENERGY_THRESHOLD:
            self.speech_active = True
            self.silence_samples = 0
            self.speech_samples += samples.size
            return

        if not self.speech_active:
            return

        self.silence_samples += samples.size
        if self.silence_samples >= self.SILENCE_SAMPLES and self.speech_samples >= self.MIN_SPEECH_SAMPLES:
            self._flush_segment()
            self.speech_active = False
            self.silence_samples = 0
            self.speech_samples = 0

    def _flush_segment(self) -> None:
        if not self.buffer:
            return
        try:
            with _gpu_inference_lock:
                text = _transcribe_pcm_faster_whisper(
                    bytes(self.buffer), self.SAMPLE_RATE, self.config
                )
        except Exception as err:
            self._sse("error", {"message": str(err)})
            self.buffer.clear()
            return
        self.buffer.clear()
        if text:
            self.committed.append(text)
            self._sse("segment", {"text": text})

    def finalize(self) -> None:
        if self.buffer and (self.speech_samples >= self.MIN_SPEECH_SAMPLES or self.committed):
            self._flush_segment()
        final_text = " ".join(self.committed).strip()
        self._sse("final", {"text": final_text})


def _read_body_stream(handler: BaseHTTPRequestHandler, callback: Any) -> None:
    transfer_encoding = str(handler.headers.get("Transfer-Encoding", "") or "").lower()
    if transfer_encoding == "chunked":
        while True:
            size_line = handler.rfile.readline().strip()
            if not size_line:
                break
            chunk_size = int(size_line, 16)
            if chunk_size == 0:
                handler.rfile.readline()
                break
            chunk = handler.rfile.read(chunk_size)
            handler.rfile.readline()
            callback(chunk)
        return

    length = int(handler.headers.get("Content-Length", "0") or "0")
    remaining = length
    while remaining > 0:
        chunk = handler.rfile.read(min(8192, remaining))
        if not chunk:
            break
        remaining -= len(chunk)
        callback(chunk)


class VoiceWorkerHandler(BaseHTTPRequestHandler):
    """JSON API for voice runtime health, STT/TTS inference, and model lifecycle."""

    server_version = "MinnowVoiceWorker/0.3"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            _json_response(self, 200, {"ok": True, "status": "ready"})
            return
        if self.path == "/voice/capabilities":
            legacy = _legacy_capabilities()
            _json_response(
                self,
                200,
                {
                    "sttLoaded": _stt_is_loaded(),
                    "ttsLoaded": _tts_is_loaded(),
                    "loadedSttModelId": _loaded_stt_model_id,
                    "loadedTtsModelId": _loaded_tts_model_id,
                    "loadedTtsMode": _loaded_tts_mode,
                    "cuda": _cuda_available(),
                    "flashAttnAvailable": _flash_attn_available(),
                    **legacy,
                    "speakers": _tts_speakers,
                    "languages": _tts_languages,
                },
            )
            return
        _json_response(self, 404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/models/load":
            self._handle_models_load()
            return
        if self.path == "/models/unload":
            self._handle_models_unload()
            return
        if self.path == "/stt/transcribe":
            self._handle_stt_transcribe()
            return
        if self.path == "/stt/stream":
            self._handle_stt_stream()
            return
        if self.path == "/tts/synthesize":
            self._handle_tts_synthesize()
            return
        if self.path == "/tts/stream":
            self._handle_tts_stream()
            return
        _json_response(self, 404, {"error": "Not found"})

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            payload = {}
        return payload if isinstance(payload, dict) else {}

    def _handle_models_load(self) -> None:
        try:
            payload = self._read_json_body()
            with _gpu_inference_lock:
                kind = str(payload.get("kind", "") or "")
                model_id = str(payload.get("modelId", "") or "").strip()
                model_path = str(payload.get("modelPath", "") or "").strip()
                config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
                if not model_id:
                    _json_response(self, 400, {"error": "modelId is required"})
                    return

                if kind == "stt":
                    if _loaded_stt_model_id == model_id and _stt_is_loaded():
                        _json_response(self, 200, {"ok": True, "modelId": model_id, "alreadyLoaded": True})
                        return
                    # Kind-scoped unload — TTS stays resident when switching STT models.
                    _unload_stt()
                    _load_stt_model(model_id, model_path, config)
                    _json_response(self, 200, {"ok": True, "modelId": model_id, "kind": "stt"})
                    return

                if kind == "tts":
                    if _loaded_tts_model_id == model_id and _tts_is_loaded():
                        _json_response(self, 200, {"ok": True, "modelId": model_id, "alreadyLoaded": True})
                        return
                    # Kind-scoped unload — STT stays resident when switching TTS models.
                    _unload_tts()
                    tokenizer_path = str(payload.get("tokenizerPath", "") or "").strip()
                    _load_tts_model(model_id, model_path, tokenizer_path, config)
                    _json_response(
                        self,
                        200,
                        {
                            "ok": True,
                            "modelId": model_id,
                            "kind": "tts",
                            "mode": _loaded_tts_mode,
                            "speakers": _tts_speakers,
                            "languages": _tts_languages,
                        },
                    )
                    return

                _json_response(self, 400, {"error": "kind must be stt or tts"})
        except Exception as err:
            _json_response(
                self,
                500,
                {"error": str(err), "trace": traceback.format_exc()[-2000:]},
            )

    def _handle_models_unload(self) -> None:
        payload = self._read_json_body()
        with _gpu_inference_lock:
            kind = str(payload.get("kind", "") or "")
            if kind == "stt":
                was_loaded = _stt_is_loaded()
                _unload_stt()
                _json_response(self, 200, {"ok": True, "wasLoaded": was_loaded, "kind": "stt"})
                return
            if kind == "tts":
                was_loaded = _tts_is_loaded()
                _unload_tts()
                _json_response(self, 200, {"ok": True, "wasLoaded": was_loaded, "kind": "tts"})
                return
            _json_response(self, 400, {"error": "kind must be stt or tts"})

    def _handle_stt_transcribe(self) -> None:
        try:
            parsed = _parse_multipart(self)
            audio = parsed.get("audio", b"")
            if not audio:
                _json_response(self, 400, {"error": "Empty audio payload"})
                return
            config = parsed.get("config", {})
            if not isinstance(config, dict):
                config = {}
            mime = str(parsed.get("mime", "audio/webm") or "audio/webm")
            with _gpu_inference_lock:
                text = _transcribe_audio(audio, config, mime)
            _json_response(self, 200, {"text": text})
        except Exception as err:
            _json_response(self, 500, {"error": str(err)})

    def _handle_stt_stream(self) -> None:
        if _fw_model is None:
            _json_response(self, 503, {"error": "STT model is not loaded"})
            return
        try:
            config_raw = self.headers.get("X-Stt-Config", "{}")
            config = json.loads(config_raw or "{}")
            if not isinstance(config, dict):
                config = {}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            session = SttStreamSession(config, self.wfile)

            def on_chunk(chunk: bytes) -> None:
                session.ingest(chunk)

            _read_body_stream(self, on_chunk)
            session.finalize()
        except Exception as err:
            try:
                _json_response(self, 500, {"error": str(err)})
            except Exception:
                pass

    def _handle_tts_synthesize(self) -> None:
        try:
            payload = self._read_json_body()
            text = str(payload.get("text", "") or "").strip()
            if not text:
                _json_response(self, 400, {"error": "text is required"})
                return
            config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
            with _gpu_inference_lock:
                audio_bytes, mime = _synthesize_tts(text, config)
            _json_response(
                self,
                200,
                {
                    "audioBase64": base64.b64encode(audio_bytes).decode("ascii"),
                    "mime": mime,
                },
            )
        except Exception as err:
            _json_response(self, 500, {"error": str(err)})

    def _handle_tts_stream(self) -> None:
        if _tts_model is None:
            _json_response(self, 503, {"error": "TTS model is not loaded"})
            return
        try:
            config_raw = self.headers.get("X-Tts-Config", "{}")
            config = json.loads(config_raw or "{}")
            if not isinstance(config, dict):
                config = {}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            session = TtsStreamSession(config, self.wfile)

            def on_chunk(chunk: bytes) -> None:
                session.ingest(chunk)

            _read_body_stream(self, on_chunk)
            session.finalize()
        except Exception as err:
            try:
                _json_response(self, 500, {"error": str(err)})
            except Exception:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Minnow voice worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), VoiceWorkerHandler)
    print(f"voice-worker listening on http://{args.host}:{args.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
