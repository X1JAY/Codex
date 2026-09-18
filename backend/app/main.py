from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.errors import register_error_handlers
from app.routes.health import router as health_router
from app.routes.analyze import router as analyze_router
from app.routes.transcribe import router as transcribe_router
from app.services.text_analysis import (
    TextAnalysisProvider,
    create_text_analysis_provider,
)
from app.services.transcription import (
    TranscriptionProvider,
    create_transcription_provider,
)


def create_app(
    settings: Settings | None = None,
    provider: TranscriptionProvider | None = None,
    text_analysis_provider: TextAnalysisProvider | None = None,
) -> FastAPI:
    resolved_settings = settings or get_settings()
    app = FastAPI(
        title="Douyin Copy Transcript Backend",
        version="0.1.0",
    )
    app.state.settings = resolved_settings
    app.state.transcription_provider = (
        provider or create_transcription_provider(resolved_settings)
    )
    app.state.text_analysis_provider = (
        text_analysis_provider or create_text_analysis_provider(resolved_settings)
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.allowed_origin_list,
        allow_origin_regex=resolved_settings.extension_origin_regex or None,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    register_error_handlers(app)
    app.include_router(health_router)
    app.include_router(transcribe_router)
    app.include_router(analyze_router)
    return app


app = create_app()
