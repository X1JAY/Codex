# 本地 FastAPI Backend

Backend 提供两个相互独立的 Provider 系统：

- Speech-to-Text：默认 `faster-whisper small`，用于 Phase 3B 与 Phase 4A。
- Text Analysis：默认 `mock`，用于 Phase 4B-1 的 API、状态和 UI 全链路验收。

文本分析没有复用或修改 faster-whisper Provider。Phase 4B-1 不连接任何远程 AI 服务。

## API

### `GET /health`

报告 Backend 和 Speech-to-Text 状态。应用启动时不加载 Whisper 模型，正常初始状态为 `model_status=not_loaded`。

### `POST /api/transcribe`

接收 `multipart/form-data`：

- `file`
- `language`
- 可选 `duration_seconds`

默认由本机 `faster-whisper small` 处理。

### `POST /api/analyze`

接收 JSON：

```json
{
  "sessionId": "phase-4a-session-id",
  "metadata": {
    "platform": "douyin",
    "url": "https://www.douyin.com/video/...",
    "hashtags": [],
    "durationSeconds": 120
  },
  "caption": "原视频文案",
  "transcript": "完整原始逐字稿",
  "transcriptLanguage": "zh",
  "outputLanguage": "zh"
}
```

返回：

```json
{
  "sourceSessionId": "phase-4a-session-id",
  "cleanedTranscript": "...",
  "keyPoints": ["...", "...", "..."],
  "structure": [{ "title": "...", "summary": "..." }],
  "hooks": [],
  "notableQuotes": [],
  "learningNotes": "..."
}
```

`keyPoints` 必须有 3～8 条；`structure` 至少一项。`hooks` 和 `notableQuotes` 可以为空数组。响应必须返回与请求匹配的 `sourceSessionId`。

## Phase 4B-1 配置

```dotenv
TEXT_ANALYSIS_PROVIDER=mock
TEXT_ANALYSIS_MAX_CHARS=50000
TEXT_ANALYSIS_TIMEOUT_SECONDS=30
```

- `mock` 是唯一已实现 Provider，结果确定且不访问网络。
- 未知 Provider 名称不会在启动时偷偷回退；调用 `/api/analyze` 时返回 `ANALYSIS_PROVIDER_UNAVAILABLE`。
- 超长逐字稿返回 `ANALYSIS_INPUT_TOO_LONG`，不做静默截断。
- Phase 4B-2 才会实现真实 AI Provider、凭据和供应商专用配置。

## 错误码

学习整理接口使用：

- `ANALYSIS_INPUT_EMPTY`
- `ANALYSIS_INPUT_TOO_LONG`
- `ANALYSIS_PROVIDER_UNAVAILABLE`
- `ANALYSIS_TIMEOUT`
- `ANALYSIS_INVALID_RESPONSE`
- `ANALYSIS_FAILED`
- `STALE_ANALYSIS_SESSION`

错误结构统一为：

```json
{
  "error": {
    "code": "ANALYSIS_FAILED",
    "message": "...",
    "raw_message": "..."
  }
}
```

## Windows 启动

从 `backend` 目录执行：

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

如需重建环境：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
```

默认链路不需要 `OPENAI_API_KEY`。

## 测试

```powershell
.venv\Scripts\python.exe -m pytest
```

测试使用注入的 fake/mock Provider，不下载 Whisper 模型、不调用外部 AI，也不消费 API 额度。

## 日志和数据边界

日志只记录请求 MIME、字节数、字符数、Provider 名称、模型和结果长度等诊断数据，不记录音频二进制、逐字稿正文、Cookie、Token 或敏感 URL。

Speech-to-Text 请求可能创建短生命周期临时音频文件，`faster-whisper` 调用结束后会清理。Backend 不写数据库。Phase 4B-1 mock 只在请求内存中处理逐字稿。

开发环境默认 CORS 正则只接受格式合法的 `chrome-extension://<id>` 来源。固定发布版本应使用 `ALLOWED_ORIGINS` 指定扩展来源并清空开发正则。
