from fastapi import APIRouter, Request

from app.schemas import HealthResponse


router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    settings = request.app.state.settings
    provider = request.app.state.transcription_provider
    provider_name = getattr(provider, "provider_name", settings.transcription_provider)

    if provider_name == "faster-whisper":
        model = getattr(provider, "model_name", settings.whisper_model)
        device = getattr(provider, "selected_device", settings.whisper_device)
        model_status = getattr(provider, "model_status", "not_loaded")
    else:
        model = getattr(provider, "model_name", settings.openai_transcribe_model)
        device = getattr(provider, "selected_device", "remote")
        model_status = getattr(provider, "model_status", "ready")

    return HealthResponse(
        ok=True,
        transcription_provider=provider_name,
        model=model,
        device=device,
        model_status=model_status,
    )
