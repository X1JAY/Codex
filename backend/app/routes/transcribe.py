import logging
import re

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile

from app.config import Settings
from app.errors import ApiError
from app.schemas import ErrorResponse, TranscriptionResponse
from app.services.transcription import (
    AudioPayload,
    ProviderError,
    TranscriptionProvider,
)


router = APIRouter(prefix="/api", tags=["transcription"])
logger = logging.getLogger(__name__)

SUPPORTED_AUDIO_TYPES = {
    "audio/flac",
    "audio/m4a",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
}
LANGUAGE_PATTERN = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def get_settings_from_app(request: Request) -> Settings:
    return request.app.state.settings


def get_provider(request: Request) -> TranscriptionProvider:
    return request.app.state.transcription_provider


@router.post(
    "/transcribe",
    response_model=TranscriptionResponse,
    responses={400: {"model": ErrorResponse}, 413: {"model": ErrorResponse}, 502: {"model": ErrorResponse}},
)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = Form("zh"),
    duration_seconds: float | None = Form(None),
    settings: Settings = Depends(get_settings_from_app),
    provider: TranscriptionProvider = Depends(get_provider),
) -> TranscriptionResponse:
    normalized_language = language.strip()
    if not LANGUAGE_PATTERN.fullmatch(normalized_language):
        raise ApiError(
            "INVALID_REQUEST",
            "language 必须是有效的语言代码，例如 zh。",
            raw_message=f"Invalid language: {language!r}",
        )

    if duration_seconds is not None and not 0 <= duration_seconds <= 600:
        raise ApiError(
            "INVALID_REQUEST",
            "duration_seconds 超出当前支持范围。",
            raw_message=f"Invalid duration_seconds: {duration_seconds}",
        )

    content_type = (file.content_type or "").strip().lower()
    base_content_type = content_type.split(";", 1)[0]
    if base_content_type not in SUPPORTED_AUDIO_TYPES:
        await file.close()
        raise ApiError(
            "INVALID_AUDIO_TYPE",
            "当前音频格式不受支持，请上传 WebM、MP3、WAV、M4A、MP4、OGG 或 FLAC。",
            raw_message=f"Unsupported content type: {content_type or '<missing>'}",
        )

    try:
        content = await file.read(settings.max_audio_bytes + 1)
    finally:
        await file.close()

    if not content:
        raise ApiError("AUDIO_EMPTY", "上传的音频为空。")
    if len(content) > settings.max_audio_bytes:
        raise ApiError(
            "AUDIO_TOO_LARGE",
            f"音频超过 {settings.max_audio_mb} MB 限制。",
            status_code=413,
        )

    audio = AudioPayload(
        filename=file.filename or "capture.webm",
        content_type=content_type or base_content_type,
        content=content,
    )

    logger.info(
        "[transcription] request accepted content_type=%s size_bytes=%d language=%s duration_seconds=%s",
        audio.content_type,
        len(audio.content),
        normalized_language,
        duration_seconds,
    )

    try:
        result = await provider.transcribe(audio, normalized_language)
    except ProviderError as error:
        raise ApiError(
            "TRANSCRIPTION_FAILED",
            "语音转写服务调用失败。",
            status_code=502,
            raw_message=str(error),
        ) from error
    except Exception as error:
        raise ApiError(
            "TRANSCRIPTION_FAILED",
            "语音转写服务发生未知错误。",
            status_code=502,
            raw_message=str(error),
        ) from error

    text = result.text.strip()
    if not text:
        raise ApiError(
            "TRANSCRIPTION_FAILED",
            "语音转写服务没有返回文字。",
            status_code=502,
            raw_message="Provider returned empty text",
        )

    measured_duration = result.duration_seconds
    if measured_duration is None:
        measured_duration = duration_seconds or 0.0

    logger.info(
        "[transcription] request completed text_length=%d language=%s duration_seconds=%s",
        len(text),
        result.language or normalized_language,
        measured_duration,
    )

    return TranscriptionResponse(
        text=text,
        language=result.language or normalized_language,
        duration_seconds=round(float(measured_duration), 3),
    )
