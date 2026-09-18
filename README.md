# 抖音视频学习助手

这是一个 Chrome / Edge Manifest V3 扩展与本地 FastAPI 服务。它读取当前抖音视频的公开页面信息，使用 Chrome `tabCapture` 捕获当前标签页音频，并通过本机 `faster-whisper` 生成逐字稿。

## 当前阶段

| 阶段 | 能力 | 当前状态 |
| --- | --- | --- |
| Phase 2 | 提取当前视频 URL、作者、可见文案和话题 | 已实现 |
| Phase 3A | 捕获约 15 秒当前标签页音频 | 已实现 |
| Phase 3B | 将短音频发送到本地 Backend 转写 | 已实现；默认 `faster-whisper small` |
| Phase 4A | 捕获完整视频并保存完整原始逐字稿状态 | 已实现并完成真实 Chrome 验收 |
| Phase 4B | 将 Phase 4A 完整逐字稿整理为学习内容 | 进行中 |
| Phase 4B-1 | 类型、独立状态机、Backend API、mock Provider、Side Panel UI | 已实现 |
| Phase 4B-2 | 接入用户选定的真实文本分析 Provider | 未开始 |

Phase 4B-1 固定输出六类内容：整理稿、核心观点、内容结构、开头钩子、金句和学习笔记。当前默认 `mock` Provider 只用于验证全链路，不代表最终 AI 分析质量。

## 关键边界

- Phase 4B 只读取 Phase 4A 已完成的 `FullTranscriptResult`，不重新捕获音频，也不调用 `/api/transcribe`。
- Phase 4A 的原始逐字稿不会被整理稿覆盖；两份数据分别保存和展示。
- Phase 4B 使用独立 `sourceSessionId`、状态机和 `chrome.storage.session` 数据。
- 新视频使用新的 session，旧视频分析结果不会显示到新视频。
- 逐字稿超过 50,000 字符时返回明确错误，不会静默截断。
- 当前 Phase 4B mock 不访问任何外部 AI 服务。

## 环境要求

- Node.js 20+
- npm 10+
- Python 3.10+
- Chrome 或 Edge（开启开发者模式）
- 当前浏览器会话可以正常观看的抖音视频

## 安装、检查与构建

在仓库根目录执行：

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

构建结果位于 `extension/dist`。

Backend 环境位于 `backend/.venv`。测试命令：

```powershell
cd backend
.venv\Scripts\python.exe -m pytest
```

## 启动本地 Backend

```powershell
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

默认语音转写配置为：

```dotenv
TRANSCRIPTION_PROVIDER=faster-whisper
WHISPER_MODEL=small
WHISPER_DEVICE=auto
WHISPER_COMPUTE_TYPE=auto
```

当前机器可在 `backend/.env` 中固定为 `WHISPER_DEVICE=cpu` 与 `WHISPER_COMPUTE_TYPE=int8`。Backend 启动和 `/health` 不会加载或下载 Whisper 模型；首次真实转写时才 lazy-load。

Phase 4B-1 默认配置为：

```dotenv
TEXT_ANALYSIS_PROVIDER=mock
TEXT_ANALYSIS_MAX_CHARS=50000
TEXT_ANALYSIS_TIMEOUT_SECONDS=30
```

没有配置 OpenAI API Key 也能运行默认链路。Phase 4B-1 不包含 OpenAI、DeepSeek、GLM、Doubao 或本地 LLM 接入。

## 加载扩展

1. 执行 `npm.cmd run build`。
2. 打开 `chrome://extensions`。
3. 开启开发者模式，选择“加载已解压的扩展程序”。
4. 选择 `extension/dist`。
5. 打开或刷新一个抖音视频页面。
6. 保持该标签页激活，点击工具栏中的“视频文案助手”。

工具栏点击是音频捕获授权入口。Side Panel 不会自行用另一个活动标签页替换已授权目标。

## Phase 4B-1 使用方式

1. 先完成 Phase 4A“完整视频转写”。
2. 完整原始逐字稿非空时，Side Panel 显示 `PHASE 4B · LEARNING`。
3. 点击“生成学习整理”。
4. mock 结果显示六个固定区域，并可分别复制整理稿、学习笔记或全部内容。
5. 关闭并重新打开 Side Panel，同一 `sourceSessionId` 的完成结果从 `chrome.storage.session` 恢复。

当前结果会明确标记 mock 限制。真实语义分析属于 Phase 4B-2。

## Backend API

- `GET /health`：Backend 与默认 STT 状态。
- `POST /api/transcribe`：multipart 音频转写。
- `POST /api/analyze`：JSON 逐字稿学习整理。
- 失败统一返回 `{ "error": { "code", "message", "raw_message" } }`。

`POST /api/analyze` 的响应字段为：

```json
{
  "sourceSessionId": "...",
  "cleanedTranscript": "...",
  "keyPoints": ["..."],
  "structure": [{ "title": "...", "summary": "..." }],
  "hooks": ["..."],
  "notableQuotes": ["..."],
  "learningNotes": "..."
}
```

## 隐私说明

- Phase 3B / Phase 4A：音频发送到 `127.0.0.1`，由本机 `faster-whisper` 转写；扩展不保存音频，Backend 临时文件在请求结束后清理。
- Phase 4B-1：逐字稿只发送到本机 Backend 的 mock Provider，不发送到外部 AI 服务。
- Phase 4B-2：如果未来启用远程文本分析 Provider，逐字稿文本可能发送给用户明确配置的 AI 服务。届时必须在文档和配置中明确说明，API Key 只能由 Backend 持有。

项目当前不包含历史记录、数据库、Markdown 下载、Web App、手机端或批量视频处理。
