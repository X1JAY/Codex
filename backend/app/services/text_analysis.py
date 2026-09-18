import math
import re
from dataclasses import dataclass
from typing import Any, Protocol

from app.config import Settings


@dataclass(frozen=True)
class LearningAnalysisInput:
    source_session_id: str
    metadata: dict[str, Any]
    caption: str | None
    transcript: str
    transcript_language: str | None
    output_language: str


@dataclass(frozen=True)
class LearningAnalysisStructureItem:
    title: str
    summary: str


@dataclass(frozen=True)
class LearningAnalysisResult:
    source_session_id: str
    cleaned_transcript: str
    key_points: list[str]
    structure: list[LearningAnalysisStructureItem]
    hooks: list[str]
    notable_quotes: list[str]
    learning_notes: str


class TextAnalysisProvider(Protocol):
    provider_name: str

    async def analyze(self, input_data: LearningAnalysisInput) -> LearningAnalysisResult:
        ...


class TextAnalysisProviderError(RuntimeError):
    pass


class TextAnalysisProviderUnavailable(TextAnalysisProviderError):
    pass


_SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?；;])\s*|\n+")


def _clean_without_translation(transcript: str) -> str:
    return "\n".join(
        line.strip()
        for line in transcript.strip().splitlines()
        if line.strip()
    )


def _source_fragments(text: str) -> list[str]:
    fragments = [part.strip() for part in _SENTENCE_BOUNDARY.split(text) if part.strip()]
    if len(fragments) >= 3:
        return fragments[:8]

    compact = " ".join(text.split())
    if compact:
        chunk_size = max(1, math.ceil(len(compact) / 3))
        fragments = [
            compact[index:index + chunk_size].strip()
            for index in range(0, len(compact), chunk_size)
            if compact[index:index + chunk_size].strip()
        ]
    if not fragments:
        return []
    while len(fragments) < 3:
        fragments.append(fragments[-1])
    return fragments[:8]


def _excerpt(value: str, limit: int = 180) -> str:
    return value if len(value) <= limit else f"{value[:limit].rstrip()}…"


class MockTextAnalysisProvider:
    """Deterministic Phase 4B-1 provider; it performs no network requests."""

    provider_name = "mock"

    async def analyze(self, input_data: LearningAnalysisInput) -> LearningAnalysisResult:
        cleaned = _clean_without_translation(input_data.transcript)
        if not cleaned:
            raise TextAnalysisProviderError("Transcript is empty")

        fragments = _source_fragments(cleaned)
        key_points = [
            f"原文片段 {index}：{_excerpt(fragment)}"
            for index, fragment in enumerate(fragments, start=1)
        ]
        structure = [
            LearningAnalysisStructureItem(
                title=f"内容段落 {index}",
                summary=_excerpt(fragment),
            )
            for index, fragment in enumerate(fragments[:4], start=1)
        ]
        opening = _excerpt(fragments[0], 140)

        return LearningAnalysisResult(
            source_session_id=input_data.source_session_id,
            cleaned_transcript=cleaned,
            key_points=key_points,
            structure=structure,
            hooks=[f"{opening}（Mock：仅标记原文开头片段，钩子类型待真实 Provider 判断）"],
            notable_quotes=[],
            learning_notes=(
                "当前结果由 Phase 4B-1 Mock Provider 生成，用于验证状态机、API 与界面全链路。"
                "它只按原文顺序整理内容，不进行真实语义推理；可复用方法、待验证观点和表达技巧"
                "将在 Phase 4B-2 接入用户选定的文本分析 Provider 后生成。"
            ),
        )


class UnavailableTextAnalysisProvider:
    def __init__(self, configured_name: str) -> None:
        self.provider_name = configured_name or "unconfigured"

    async def analyze(self, _input_data: LearningAnalysisInput) -> LearningAnalysisResult:
        raise TextAnalysisProviderUnavailable(
            f"Text analysis provider {self.provider_name!r} is not available"
        )


def create_text_analysis_provider(settings: Settings) -> TextAnalysisProvider:
    provider_name = settings.text_analysis_provider.strip().lower()
    if provider_name == "mock":
        return MockTextAnalysisProvider()
    return UnavailableTextAnalysisProvider(provider_name)
