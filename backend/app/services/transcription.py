import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Protocol

from openai import AsyncOpenAI

from app.config import Settings


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AudioPayload:
    filename: str
    content_type: str
    content: bytes


@dataclass(frozen=True)
class ProviderTranscription:
    text: str
    language: str
    duration_seconds: float | None = None


class TranscriptionProvider(Protocol):
    async def transcribe(
        self,
        audio: AudioPayload,
        language: str,
    ) -> ProviderTranscription: ...


class ProviderError(RuntimeError):
    """A provider failed without exposing secrets or audio content."""


def _cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _resolve_device(configured_device: str) -> str:
    normalized = configured_device.strip().lower()
    if normalized != "auto":
        return normalized or "cpu"
    return "cuda" if _cuda_available() else "cpu"


def _resolve_compute_type(compute_type: str) -> str:
    normalized = compute_type.strip().lower()
    return "default" if not normalized or normalized == "auto" else normalized


ModelFactory = Callable[..., Any]


def _default_model_factory(
    model_name: str,
    *,
    device: str,
    compute_type: str,
    download_root: str,
) -> Any:
    from faster_whisper import WhisperModel

    return WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        download_root=download_root,
    )


class FasterWhisperProvider:
    provider_name = "faster-whisper"

    def __init__(
        self,
        model_name: str,
        device: str,
        compute_type: str,
        language: str,
        model_dir: str,
        *,
        model_factory: ModelFactory | None = None,
    ) -> None:
        self.model_name = model_name
        self.selected_device = _resolve_device(device)
        self._compute_type = _resolve_compute_type(compute_type)
        self._language = language
        self._model_dir = Path(model_dir)
        self._model_factory = model_factory or _default_model_factory
        self._model: Any | None = None
        self._model_lock = Lock()

    @property
    def model_status(self) -> str:
        return "ready" if self._model is not None else "not_loaded"

    def _get_model(self) -> Any:
        if self._model is not None:
            return self._model

        with self._model_lock:
            if self._model is None:
                logger.info("[whisper] model=%s", self.model_name)
                logger.info("[whisper] download_root=%s", self._model_dir)
                logger.info("[whisper] requested device=%s", self.selected_device)
                logger.info("[whisper] compute_type=%s", self._compute_type)
                logger.info("[whisper] downloading/loading model")
                self._model_dir.mkdir(parents=True, exist_ok=True)
                self._model = self._model_factory(
                    self.model_name,
                    device=self.selected_device,
                    compute_type=self._compute_type,
                    download_root=str(self._model_dir),
                )
                logger.info("[whisper] model ready")
        return self._model

    @staticmethod
    def _temporary_suffix(audio: AudioPayload) -> str:
        suffix = Path(audio.filename).suffix
        if suffix:
            return suffix
        return {
            "audio/webm": ".webm",
            "audio/ogg": ".ogg",
            "audio/mpeg": ".mp3",
            "audio/mp4": ".mp4",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/flac": ".flac",
        }.get(audio.content_type.split(";", 1)[0], ".audio")

    def _transcribe_sync(self, audio: AudioPayload, language: str) -> ProviderTranscription:
        temp_path: str | None = None
        file_descriptor, temp_path = tempfile.mkstemp(
            prefix="douyin-transcription-",
            suffix=self._temporary_suffix(audio),
        )
        try:
            with os.fdopen(file_descriptor, "wb") as temporary_file:
                temporary_file.write(audio.content)

            segments, info = self._get_model().transcribe(
                temp_path,
                language=language or self._language,
                task="transcribe",
                vad_filter=True,
            )
            text = "".join(str(getattr(segment, "text", "")) for segment in segments).strip()
            if not text:
                raise ProviderError("Speech-to-Text provider returned empty text")

            response_language = getattr(info, "language", None)
            response_duration = getattr(info, "duration", None)
            return ProviderTranscription(
                text=text,
                language=str(response_language).strip() if response_language else language,
                duration_seconds=(
                    float(response_duration)
                    if isinstance(response_duration, (int, float))
                    else None
                ),
            )
        except ProviderError:
            raise
        except Exception as error:
            raise ProviderError(str(error)) from error
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass
                except OSError:
                    logger.warning("[whisper] failed to remove temporary audio file")

    async def transcribe(
        self,
        audio: AudioPayload,
        language: str,
    ) -> ProviderTranscription:
        logger.info(
            "[whisper] request content_type=%s size_bytes=%d language=%s",
            audio.content_type,
            len(audio.content),
            language,
        )
        return await asyncio.to_thread(self._transcribe_sync, audio, language)


class MissingOpenAIKeyProvider:
    provider_name = "openai"
    model_name = "gpt-4o-mini-transcribe"
    selected_device = "remote"
    model_status = "not_configured"

    async def transcribe(
        self,
        _audio: AudioPayload,
        _language: str,
    ) -> ProviderTranscription:
        raise ProviderError("OPENAI_API_KEY is not configured")


class OpenAITranscriptionProvider:
    provider_name = "openai"
    selected_device = "remote"
    model_status = "ready"

    def __init__(
        self,
        api_key: str,
        model: str,
        timeout_seconds: float,
        client: AsyncOpenAI | None = None,
    ) -> None:
        self.model_name = model
        self._model = model
        self._client = client or AsyncOpenAI(
            api_key=api_key,
            timeout=timeout_seconds,
        )

    async def transcribe(
        self,
        audio: AudioPayload,
        language: str,
    ) -> ProviderTranscription:
        logger.info(
            "[transcription] provider request model=%s content_type=%s size_bytes=%d language=%s",
            self._model,
            audio.content_type,
            len(audio.content),
            language,
        )
        try:
            response = await self._client.audio.transcriptions.create(
                model=self._model,
                file=(audio.filename, audio.content, audio.content_type),
                language=language,
                response_format="json",
            )
        except Exception as error:  # Provider SDK exceptions share no stable base contract.
            raise ProviderError(str(error)) from error

        text = str(getattr(response, "text", "")).strip()
        if not text:
            raise ProviderError("Speech-to-Text provider returned empty text")

        response_language = getattr(response, "language", None)
        response_duration = getattr(response, "duration", None)
        result = ProviderTranscription(
            text=text,
            language=(str(response_language).strip() if response_language else language),
            duration_seconds=(
                float(response_duration)
                if isinstance(response_duration, (int, float))
                else None
            ),
        )
        logger.info(
            "[transcription] provider response model=%s text_length=%d language=%s duration_seconds=%s",
            self._model,
            len(result.text),
            result.language,
            result.duration_seconds,
        )
        return result


def create_transcription_provider(settings: Settings) -> TranscriptionProvider:
    provider_name = settings.transcription_provider.strip().lower()
    if provider_name == "openai":
        if settings.openai_api_key is None:
            return MissingOpenAIKeyProvider()
        return OpenAITranscriptionProvider(
            api_key=settings.openai_api_key.get_secret_value(),
            model=settings.openai_transcribe_model,
            timeout_seconds=settings.transcription_timeout_seconds,
        )

    if provider_name not in {"faster-whisper", "faster_whisper"}:
        raise ValueError(f"Unsupported transcription provider: {settings.transcription_provider}")

    return FasterWhisperProvider(
        model_name=settings.whisper_model,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
        language=settings.whisper_language,
        model_dir=settings.whisper_model_dir,
    )
