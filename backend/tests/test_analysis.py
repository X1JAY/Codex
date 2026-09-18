import asyncio
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.text_analysis import (
    LearningAnalysisInput,
    LearningAnalysisResult,
    LearningAnalysisStructureItem,
    MockTextAnalysisProvider,
    TextAnalysisProviderError,
    UnavailableTextAnalysisProvider,
    create_text_analysis_provider,
)
from app.services.transcription import AudioPayload, ProviderTranscription


class NoopTranscriptionProvider:
    async def transcribe(
        self,
        _audio: AudioPayload,
        language: str,
    ) -> ProviderTranscription:
        return ProviderTranscription(text="unused", language=language)


def analysis_result(source_session_id: str = "session-4b") -> LearningAnalysisResult:
    return LearningAnalysisResult(
        source_session_id=source_session_id,
        cleaned_transcript="整理稿保留原文语言。",
        key_points=["观点一", "观点二", "观点三"],
        structure=[LearningAnalysisStructureItem(title="开头", summary="提出主题")],
        hooks=[],
        notable_quotes=[],
        learning_notes="学习笔记",
    )


class CapturingProvider:
    provider_name = "test"

    def __init__(self) -> None:
        self.calls: list[LearningAnalysisInput] = []

    async def analyze(self, input_data: LearningAnalysisInput) -> LearningAnalysisResult:
        self.calls.append(input_data)
        return analysis_result(input_data.source_session_id)


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "openai_api_key": None,
        "text_analysis_provider": "mock",
        "text_analysis_max_chars": 50_000,
        "text_analysis_timeout_seconds": 1,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def request_body(transcript: str = "原始逐字稿第一句。第二句。第三句。") -> dict[str, Any]:
    return {
        "sessionId": "session-4b",
        "metadata": {
            "platform": "douyin",
            "url": "https://www.douyin.com/video/4",
            "videoId": "4",
            "author": "测试作者",
            "caption": "原视频文案",
            "hashtags": ["学习"],
            "durationSeconds": 30,
            "extractedAt": "2026-09-18T00:00:00.000Z",
        },
        "caption": "原视频文案",
        "transcript": transcript,
        "transcriptLanguage": "zh",
        "outputLanguage": "zh",
    }


def client(provider: Any, custom_settings: Settings | None = None) -> TestClient:
    return TestClient(create_app(
        custom_settings or settings(),
        NoopTranscriptionProvider(),
        provider,
    ))


def test_analyze_contract_preserves_input_and_returns_six_fields() -> None:
    provider = CapturingProvider()
    test_client = client(provider)
    raw = "  English opening. 日本語の本文。 한국어 문장.  "

    response = test_client.post("/api/analyze", json=request_body(raw))

    assert response.status_code == 200
    assert response.json() == {
        "sourceSessionId": "session-4b",
        "cleanedTranscript": "整理稿保留原文语言。",
        "keyPoints": ["观点一", "观点二", "观点三"],
        "structure": [{"title": "开头", "summary": "提出主题"}],
        "hooks": [],
        "notableQuotes": [],
        "learningNotes": "学习笔记",
    }
    assert len(provider.calls) == 1
    assert provider.calls[0].transcript == raw
    assert provider.calls[0].transcript_language == "zh"
    assert provider.calls[0].output_language == "zh"


def test_mock_provider_is_deterministic_multilingual_and_does_not_translate() -> None:
    provider = MockTextAnalysisProvider()
    raw = "English opening. 日本語の本文です。 한국어 문장입니다."
    input_data = LearningAnalysisInput(
        source_session_id="multi",
        metadata={},
        caption=None,
        transcript=raw,
        transcript_language=None,
        output_language="zh",
    )

    first = asyncio.run(provider.analyze(input_data))
    second = asyncio.run(provider.analyze(input_data))

    assert first == second
    assert first.cleaned_transcript == raw
    assert len(first.key_points) == 3
    assert "Mock Provider" in first.learning_notes


def test_empty_transcript_is_rejected_without_calling_provider() -> None:
    provider = CapturingProvider()

    response = client(provider).post("/api/analyze", json=request_body("   \n"))

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "ANALYSIS_INPUT_EMPTY"
    assert provider.calls == []


def test_long_transcript_is_rejected_without_silent_truncation() -> None:
    provider = CapturingProvider()
    limited_settings = settings(text_analysis_max_chars=10)
    transcript = "字" * 11

    response = client(provider, limited_settings).post(
        "/api/analyze",
        json=request_body(transcript),
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "ANALYSIS_INPUT_TOO_LONG"
    assert provider.calls == []


def test_unavailable_provider_has_explicit_error() -> None:
    response = client(UnavailableTextAnalysisProvider("disabled")).post(
        "/api/analyze",
        json=request_body(),
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ANALYSIS_PROVIDER_UNAVAILABLE"


def test_provider_timeout_has_explicit_error() -> None:
    class SlowProvider:
        provider_name = "slow"

        async def analyze(self, _input_data: LearningAnalysisInput) -> LearningAnalysisResult:
            await asyncio.sleep(0.1)
            return analysis_result()

    timeout_settings = settings(text_analysis_timeout_seconds=0.001)
    response = client(SlowProvider(), timeout_settings).post(
        "/api/analyze",
        json=request_body(),
    )

    assert response.status_code == 504
    assert response.json()["error"]["code"] == "ANALYSIS_TIMEOUT"


def test_invalid_provider_response_is_rejected() -> None:
    class InvalidProvider:
        provider_name = "invalid"

        async def analyze(self, input_data: LearningAnalysisInput) -> LearningAnalysisResult:
            return LearningAnalysisResult(
                source_session_id=input_data.source_session_id,
                cleaned_transcript="整理稿",
                key_points=["不足三条", "仍不足"],
                structure=[LearningAnalysisStructureItem(title="开头", summary="摘要")],
                hooks=[],
                notable_quotes=[],
                learning_notes="笔记",
            )

    response = client(InvalidProvider()).post("/api/analyze", json=request_body())

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "ANALYSIS_INVALID_RESPONSE"


def test_stale_provider_result_is_rejected() -> None:
    class StaleProvider:
        provider_name = "stale"

        async def analyze(self, _input_data: LearningAnalysisInput) -> LearningAnalysisResult:
            return analysis_result("older-session")

    response = client(StaleProvider()).post("/api/analyze", json=request_body())

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "STALE_ANALYSIS_SESSION"


def test_provider_failure_has_explicit_error() -> None:
    class FailingProvider:
        provider_name = "failing"

        async def analyze(self, _input_data: LearningAnalysisInput) -> LearningAnalysisResult:
            raise TextAnalysisProviderError("test failure")

    response = client(FailingProvider()).post("/api/analyze", json=request_body())

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "ANALYSIS_FAILED"


def test_provider_factory_defaults_to_local_mock_and_unknown_is_unavailable() -> None:
    default_provider = create_text_analysis_provider(settings())
    unknown_provider = create_text_analysis_provider(settings(text_analysis_provider="future-ai"))

    assert isinstance(default_provider, MockTextAnalysisProvider)
    assert isinstance(unknown_provider, UnavailableTextAnalysisProvider)
