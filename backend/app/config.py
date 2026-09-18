from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    transcription_provider: str = "faster-whisper"
    whisper_model: str = "small"
    whisper_device: str = "auto"
    whisper_compute_type: str = "auto"
    whisper_language: str = "zh"
    whisper_model_dir: str = r"D:\AI-Caches\whisper"
    openai_api_key: SecretStr | None = None
    openai_transcribe_model: str = "gpt-4o-mini-transcribe"
    max_audio_mb: int = 50
    transcription_timeout_seconds: float = 120.0
    text_analysis_provider: str = "mock"
    text_analysis_max_chars: int = 50_000
    text_analysis_timeout_seconds: float = 30.0
    allowed_origins: str = ""
    extension_origin_regex: str = r"^chrome-extension://[a-p]{32}$"

    @property
    def allowed_origin_list(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        ]

    @property
    def max_audio_bytes(self) -> int:
        return self.max_audio_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
