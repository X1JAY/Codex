from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.transcription import (
    AudioPayload,
    ProviderError,
    ProviderTranscription,
)


class MockProvider:
    def __init__(self) -> None:
        self.calls: list[tuple[AudioPayload, str]] = []

    async def transcribe(
        self,
        audio: AudioPayload,
        language: str,
    ) -> ProviderTranscription:
        self.calls.append((audio, language))
        return ProviderTranscription(
            text="这是测试口播逐字稿。",
            language=language,
        )


class FailingProvider:
    async def transcribe(
        self,
        _audio: AudioPayload,
        _language: str,
    ) -> ProviderTranscription:
        raise ProviderError("provider request failed")


def test_settings() -> Settings:
    return Settings(
        _env_file=None,
        openai_api_key=None,
        max_audio_mb=1,
        allowed_origins="",
    )


def test_health_endpoint() -> None:
    client = TestClient(create_app(test_settings(), MockProvider()))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "transcription_provider": "faster-whisper",
        "model": "small",
        "device": "auto",
        "model_status": "not_loaded",
    }


def test_transcribe_uses_mock_provider_and_returns_text() -> None:
    provider = MockProvider()
    client = TestClient(create_app(test_settings(), provider))

    response = client.post(
        "/api/transcribe",
        files={"file": ("capture.webm", b"webm-audio", "audio/webm;codecs=opus")},
        data={"language": "zh", "duration_seconds": "15.0"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "这是测试口播逐字稿。",
        "language": "zh",
        "duration_seconds": 15.0,
    }
    assert len(provider.calls) == 1
    audio, language = provider.calls[0]
    assert audio.content == b"webm-audio"
    assert audio.content_type == "audio/webm;codecs=opus"
    assert language == "zh"


def test_transcribe_rejects_invalid_audio_type() -> None:
    client = TestClient(create_app(test_settings(), MockProvider()))

    response = client.post(
        "/api/transcribe",
        files={"file": ("capture.txt", b"not-audio", "text/plain")},
        data={"language": "zh"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_AUDIO_TYPE"


def test_validation_errors_use_unified_error_shape() -> None:
    client = TestClient(create_app(test_settings(), MockProvider()))

    response = client.post("/api/transcribe", data={"language": "zh"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_provider_failure_uses_unified_error_shape() -> None:
    client = TestClient(create_app(test_settings(), FailingProvider()))

    response = client.post(
        "/api/transcribe",
        files={"file": ("capture.webm", b"webm-audio", "audio/webm")},
        data={"language": "zh", "duration_seconds": "15"},
    )

    assert response.status_code == 502
    assert response.json() == {
        "error": {
            "code": "TRANSCRIPTION_FAILED",
            "message": "语音转写服务调用失败。",
            "raw_message": "provider request failed",
        }
    }


def test_chrome_extension_origin_is_allowed_by_cors() -> None:
    client = TestClient(create_app(test_settings(), MockProvider()))
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

    response = client.options(
        "/api/transcribe",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_untrusted_web_origin_is_not_allowed_by_cors() -> None:
    client = TestClient(create_app(test_settings(), MockProvider()))

    response = client.options(
        "/api/transcribe",
        headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert "access-control-allow-origin" not in response.headers
