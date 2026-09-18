import asyncio
import logging

from fastapi import APIRouter, Depends, Request

from app.config import Settings
from app.errors import ApiError
from app.schemas import (
    ErrorResponse,
    LearningAnalysisRequest,
    LearningAnalysisResponse,
    LearningAnalysisStructureItemResponse,
)
from app.services.text_analysis import (
    LearningAnalysisInput,
    LearningAnalysisResult,
    LearningAnalysisStructureItem,
    TextAnalysisProvider,
    TextAnalysisProviderError,
    TextAnalysisProviderUnavailable,
)


router = APIRouter(prefix="/api", tags=["learning-analysis"])
logger = logging.getLogger(__name__)


def get_settings_from_app(request: Request) -> Settings:
    return request.app.state.settings


def get_text_analysis_provider(request: Request) -> TextAnalysisProvider:
    return request.app.state.text_analysis_provider


def _invalid_provider_response(raw_message: str) -> ApiError:
    return ApiError(
        "ANALYSIS_INVALID_RESPONSE",
        "文本分析 Provider 返回了无效结果。",
        status_code=502,
        raw_message=raw_message,
    )


def _validated_response(
    result: LearningAnalysisResult,
    expected_session_id: str,
) -> LearningAnalysisResponse:
    if not isinstance(result, LearningAnalysisResult):
        raise _invalid_provider_response("Provider did not return LearningAnalysisResult.")
    if (
        not isinstance(result.source_session_id, str)
        or not isinstance(result.cleaned_transcript, str)
        or not isinstance(result.learning_notes, str)
        or not isinstance(result.key_points, list)
        or not all(isinstance(point, str) for point in result.key_points)
        or not isinstance(result.structure, list)
        or not all(isinstance(item, LearningAnalysisStructureItem) for item in result.structure)
        or not isinstance(result.hooks, list)
        or not all(isinstance(hook, str) for hook in result.hooks)
        or not isinstance(result.notable_quotes, list)
        or not all(isinstance(quote, str) for quote in result.notable_quotes)
    ):
        raise _invalid_provider_response("Provider response fields have invalid runtime types.")
    if result.source_session_id != expected_session_id:
        raise ApiError(
            "STALE_ANALYSIS_SESSION",
            "学习整理结果不属于当前完整转写任务。",
            status_code=409,
            raw_message=(
                f"Expected source session {expected_session_id!r}, "
                f"received {result.source_session_id!r}"
            ),
        )

    cleaned = result.cleaned_transcript.strip()
    notes = result.learning_notes.strip()
    key_points = [point.strip() for point in result.key_points if point.strip()]
    hooks = [hook.strip() for hook in result.hooks if hook.strip()]
    quotes = [quote.strip() for quote in result.notable_quotes if quote.strip()]
    structure = [
        LearningAnalysisStructureItemResponse(
            title=item.title.strip(),
            summary=item.summary.strip(),
        )
        for item in result.structure
        if item.title.strip() and item.summary.strip()
    ]
    if (
        not cleaned
        or not notes
        or not 3 <= len(key_points) <= 8
        or not structure
        or len(key_points) != len(result.key_points)
        or len(hooks) != len(result.hooks)
        or len(quotes) != len(result.notable_quotes)
        or len(structure) != len(result.structure)
    ):
        raise _invalid_provider_response(
            "Response must contain all six result fields and 3-8 non-empty key points."
        )

    return LearningAnalysisResponse(
        source_session_id=result.source_session_id,
        cleaned_transcript=cleaned,
        key_points=key_points,
        structure=structure,
        hooks=hooks,
        notable_quotes=quotes,
        learning_notes=notes,
    )


@router.post(
    "/analyze",
    response_model=LearningAnalysisResponse,
    responses={
        400: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
        504: {"model": ErrorResponse},
    },
)
async def analyze_transcript(
    payload: LearningAnalysisRequest,
    settings: Settings = Depends(get_settings_from_app),
    provider: TextAnalysisProvider = Depends(get_text_analysis_provider),
) -> LearningAnalysisResponse:
    transcript = payload.transcript
    if not transcript.strip():
        raise ApiError(
            "ANALYSIS_INPUT_EMPTY",
            "完整逐字稿为空，无法生成学习整理。",
        )
    if len(transcript) > settings.text_analysis_max_chars:
        raise ApiError(
            "ANALYSIS_INPUT_TOO_LONG",
            (
                f"完整逐字稿超过 {settings.text_analysis_max_chars} 字符限制，"
                "当前版本不会静默截断。"
            ),
            status_code=413,
        )

    input_data = LearningAnalysisInput(
        source_session_id=payload.session_id,
        metadata=payload.metadata.model_dump(by_alias=True, exclude_none=True),
        caption=payload.caption,
        transcript=transcript,
        transcript_language=payload.transcript_language,
        output_language=payload.output_language,
    )
    logger.info(
        "[analysis] request accepted provider=%s transcript_chars=%d output_language=%s",
        provider.provider_name,
        len(transcript),
        payload.output_language,
    )

    try:
        result = await asyncio.wait_for(
            provider.analyze(input_data),
            timeout=settings.text_analysis_timeout_seconds,
        )
    except asyncio.TimeoutError as error:
        raise ApiError(
            "ANALYSIS_TIMEOUT",
            "学习整理请求超时。",
            status_code=504,
            raw_message=str(error) or "Text analysis provider timed out",
        ) from error
    except TextAnalysisProviderUnavailable as error:
        raise ApiError(
            "ANALYSIS_PROVIDER_UNAVAILABLE",
            "当前文本分析 Provider 不可用。",
            status_code=503,
            raw_message=str(error),
        ) from error
    except TextAnalysisProviderError as error:
        raise ApiError(
            "ANALYSIS_FAILED",
            "文本分析 Provider 执行失败。",
            status_code=502,
            raw_message=str(error),
        ) from error
    except Exception as error:
        raise ApiError(
            "ANALYSIS_FAILED",
            "生成学习整理时发生未知错误。",
            status_code=502,
            raw_message=str(error),
        ) from error

    response = _validated_response(result, payload.session_id)
    logger.info(
        "[analysis] response returned provider=%s key_points=%d structure_items=%d",
        provider.provider_name,
        len(response.key_points),
        len(response.structure),
    )
    return response
