# Voice

Minnow supports dictation and read-aloud without installing Python or configuring an API key. Built-in dictation runs on your device; read-aloud uses your system's speech voices.

Press the composer microphone to dictate, or **Read aloud** on an assistant reply. Choose other voices and models in **Models → Voice**.

## Dictation

The microphone button in the composer. Press it, talk, and your words appear in the composer where you can edit them before sending.

Available options:

- **Built-in** (default) — records immediately and transcribes when you pause or stop. A compact Whisper Tiny model downloads automatically on first use and stays cached. The first transcription needs an internet connection and can take longer while the model prepares. Audio stays on your device.
- **Advanced local** — a Python Whisper worker supports live transcription, with words appearing progressively.
- **External API** — sends the recording to your configured provider when you stop.

Minnow watches for silence and can end the recording for you rather than making you find the button again.

Dictation replaces only the range it inserted, so speaking into a half-written message adds to it instead of wiping it.

## Speech-to-text models

Built-in dictation uses a compact, quantized Whisper Tiny model. Larger optional models are available under **Models → Voice** for better recognition of technical vocabulary:

| Model | Trade-off |
|-------|-----------|
| **Whisper Tiny** | Fastest, least accurate. Fine for short commands. |
| **Whisper Base** | A good default on modest hardware |
| **Whisper Small** | Noticeably better on technical vocabulary |
| **Whisper Medium** | Better again; heavier |
| **Whisper Large v3** | Best accuracy, largest download |

Technical terms, names and code identifiers are where the bigger models earn their size. If you dictate prose, Base is usually enough.

You can point speech-to-text at a provider instead of running it locally.

## Text-to-speech

**System voice** is the default and needs no Minnow model download. Click **Read aloud** again to stop. Voice availability and quality depend on your operating system. System speech uses the system output device; select a local voice to keep speech on-device.

For advanced local speech, Qwen3-TTS models are available in 0.6B and 1.7B sizes:

- **CustomVoice** — pick from provided voices.
- **VoiceDesign** — describe the voice you want.
- **Base (clone)** — clone a voice from a sample.

The 0.6B models are quicker to generate; the 1.7B models sound better.

Local speech buffers audio before playback. When generation cannot keep up with speaking speed, Minnow prepares the full clip first to avoid repeated pauses. Click **Read aloud** again to cancel preparation or stop playback.

Speed and output format are configurable, along with limits on audio size and duration.

## The Python worker

The Python worker is optional. Open **Models → Voice → Advanced local voice setup** to install it for larger Whisper models or Qwen voices. Built-in dictation and system speech do not use it.

An installed worker starts on demand. Older default configurations without downloaded voice models use built-in dictation and system speech automatically. Installed local models and configured external providers remain available.

## Audio devices

**Settings → General → Audio** picks your input and output devices and toggles echo cancellation, noise suppression and automatic gain control.

If dictation is picking up your speakers, echo cancellation is the setting to check first.

## Where the models live

Under `models/voice/` in your Minnow home. Built-in dictation caches its model in `models/voice/builtin/` and reloads cached weights in the background on app startup. The optional Python environment lives under `voice/`.

## Related

- [Models app](../apps/models.md)
- [Working in chat](../chat/chatting.md)
- [Where your data lives](../reference/configuration.md)
