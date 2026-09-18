import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import app.services.transcription as transcription_module
from openai import AsyncOpenAI

from app.config import Settings
from app.services.transcription import (
    AudioPayload,
    FasterWhisperProvider,
    OpenAITranscriptionProvider,
    create_transcription_provider,
)


class FakeTranscriptions:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> SimpleNamespace:
        self.kwargs = kwargs
        return SimpleNamespace(text="模拟中文逐字稿", language="zh", duration=15.0)


class FakeAudio:
    def __init__(self) -> None:
        self.transcriptions = FakeTranscriptions()


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.audio = FakeAudio()


def test_openai_provider_uses_configured_model_without_real_api_call() -> None:
    client = FakeOpenAIClient()
    provider = OpenAITranscriptionProvider(
        api_key="test-only-key",
        model="configured-transcribe-model",
        timeout_seconds=30,
        client=cast(AsyncOpenAI, client),
    )
    audio = AudioPayload(
        filename="capture.webm",
        content_type="audio/webm;codecs=opus",
        content=b"audio-bytes",
    )

    result = asyncio.run(provider.transcribe(audio, "zh"))

    assert result.text == "模拟中文逐字稿"
    assert result.language == "zh"
    assert result.duration_seconds == 15.0
    assert client.audio.transcriptions.kwargs == {
        "model": "configured-transcribe-model",
        "file": ("capture.webm", b"audio-bytes", "audio/webm;codecs=opus"),
        "language": "zh",
        "response_format": "json",
    }


def test_default_provider_is_faster_whisper_and_does_not_load_model() -> None:
    settings = Settings(_env_file=None)

    provider = create_transcription_provider(settings)

    assert isinstance(provider, FasterWhisperProvider)
    assert provider.provider_name == "faster-whisper"
    assert provider.model_name == "small"
    assert provider.model_status == "not_loaded"


def test_auto_device_falls_back_to_cpu(monkeypatch: Any) -> None:
    monkeypatch.setattr(transcription_module, "_cuda_available", lambda: False)

    provider = FasterWhisperProvider(
        model_name="small",
        device="auto",
        compute_type="auto",
        language="zh",
        model_dir="D:\\AI-Caches\\whisper",
        model_factory=lambda *_args, **_kwargs: object(),
    )

    assert provider.selected_device == "cpu"


def test_faster_whisper_model_is_reused_and_temp_file_is_cleaned(tmp_path: Path) -> None:
    factory_calls: list[dict[str, Any]] = []
    transcribe_paths: list[str] = []

    class FakeModel:
        def transcribe(self, path: str, **_kwargs: Any) -> tuple[list[Any], Any]:
            transcribe_paths.append(path)
            assert Path(path).exists()
            return [SimpleNamespace(text="本地转写结果")], SimpleNamespace(
                language="zh",
                duration=2.5,
            )

    def factory(*args: Any, **kwargs: Any) -> FakeModel:
        factory_calls.append({"args": args, **kwargs})
        return FakeModel()

    provider = FasterWhisperProvider(
        model_name="small",
        device="cpu",
        compute_type="auto",
        language="zh",
        model_dir=str(tmp_path / "whisper-cache"),
        model_factory=factory,
    )
    audio = AudioPayload(
        filename="capture.webm",
        content_type="audio/webm;codecs=opus",
        content=b"webm-audio",
    )

    first = asyncio.run(provider.transcribe(audio, "zh"))
    second = asyncio.run(provider.transcribe(audio, "zh"))

    assert first.text == "本地转写结果"
    assert second.text == "本地转写结果"
    assert len(factory_calls) == 1
    assert factory_calls[0]["args"] == ("small",)
    assert factory_calls[0]["device"] == "cpu"
    assert factory_calls[0]["compute_type"] == "default"
    assert factory_calls[0]["download_root"] == str(tmp_path / "whisper-cache")
    assert all(not Path(path).exists() for path in transcribe_paths)
    assert provider.model_status == "ready"
