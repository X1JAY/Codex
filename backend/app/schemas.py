from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    ok: bool = True
    transcription_provider: str
    model: str
    device: str
    model_status: str


class TranscriptionResponse(BaseModel):
    text: str
    language: str
    duration_seconds: float = Field(ge=0)


class AnalysisMetadata(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")

    platform: str | None = None
    url: str | None = None
    video_id: str | None = Field(default=None, alias="videoId")
    author: str | None = None
    caption: str | None = None
    hashtags: list[str] = Field(default_factory=list)
    duration_seconds: float | None = Field(default=None, alias="durationSeconds")
    extracted_at: str | None = Field(default=None, alias="extractedAt")


class LearningAnalysisRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(alias="sessionId", min_length=1)
    metadata: AnalysisMetadata
    caption: str | None = None
    transcript: str
    transcript_language: str | None = Field(default=None, alias="transcriptLanguage")
    output_language: str = Field(default="zh", alias="outputLanguage", min_length=2)


class LearningAnalysisStructureItemResponse(BaseModel):
    title: str
    summary: str


class LearningAnalysisResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    source_session_id: str = Field(alias="sourceSessionId")
    cleaned_transcript: str = Field(alias="cleanedTranscript")
    key_points: list[str] = Field(alias="keyPoints")
    structure: list[LearningAnalysisStructureItemResponse]
    hooks: list[str]
    notable_quotes: list[str] = Field(alias="notableQuotes")
    learning_notes: str = Field(alias="learningNotes")


class ErrorDetail(BaseModel):
    code: str
    message: str
    raw_message: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail
