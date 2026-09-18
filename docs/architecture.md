# Architecture

## 阶段定义

```text
Phase 2   当前抖音视频公开页面 metadata / 文案
Phase 3A  当前标签页约 15 秒音频捕获
Phase 3B  短音频 -> 本机 faster-whisper -> 短逐字稿
Phase 4A  完整视频 -> 本机 faster-whisper -> 完整原始逐字稿
Phase 4B  完整原始逐字稿 -> 学习整理
  4B-1   架构 + UI + API + mock Provider
  4B-2   用户选定的真实文本分析 Provider（尚未开始）
```

## Provider 边界

```text
Speech-to-Text Provider                 Text Analysis Provider
-----------------------                 ----------------------
输入：音频                              输入：Phase 4A 文本结果
默认：faster-whisper small              默认：mock
端点：POST /api/transcribe              端点：POST /api/analyze
输出：原始逐字稿                        输出：六类学习整理
```

两个 Provider 系统互不依赖。Phase 4B 不调用音频捕获、不调用 `/api/transcribe`、不加载 Whisper，也不修改 Phase 4A 状态。

## Phase 4A 冻结链路

```text
Toolbar user gesture
  -> authorized Douyin tab
  -> content video discovery / playback control
  -> tabCapture stream ID
  -> Offscreen MediaRecorder
  -> complete in-memory WebM Blob
  -> localhost POST /api/transcribe
  -> faster-whisper small
  -> FullTranscriptResult
  -> chrome.storage.session
  -> Side Panel original transcript
```

Phase 4B-1 未修改 content script、视频发现、tabCapture、Offscreen、音频捕获、转写或完整转写模块。它只从 Side Panel 已持有的 `FullTranscriptionStatus.result` 读取数据。

## Phase 4B-1 数据流

```text
Phase 4A FullTranscriptionStatus
  -> require state=completed + non-empty transcript + sessionId
  -> create LearningAnalysisInput
       sourceSessionId
       tabId
       metadata
       caption
       transcript (原样传递)
       transcriptLanguage
       outputLanguage=zh
  -> Background LearningAnalysisController
       independent idle / ready / processing / completed / error state
       persist learningAnalysisStatus in chrome.storage.session
  -> POST http://127.0.0.1:8787/api/analyze
  -> Backend TextAnalysisProvider interface
  -> Phase 4B-1 MockTextAnalysisProvider (no network)
  -> LearningAnalysisResult
  -> sourceSessionId validation
  -> session storage + Side Panel broadcast
  -> six result sections and three copy actions
```

## 数据结构

```ts
interface LearningAnalysisResult {
  sourceSessionId: string;
  cleanedTranscript: string;
  keyPoints: string[];
  structure: Array<{
    title: string;
    summary: string;
  }>;
  hooks: string[];
  notableQuotes: string[];
  learningNotes: string;
}
```

`cleanedTranscript` 是独立派生字段，绝不写回 `FullTranscriptResult.transcript.text`。输入语言不限；整理稿保留原始语言，分析字段默认中文。

## Session 与恢复

`LearningAnalysisStatus` 使用独立 `sourceSessionId` 绑定 Phase 4A 来源：

- 同一 session 关闭并重开 Side Panel：从 `chrome.storage.session` 恢复完成结果。
- 切换到新的 Phase 4A session：先进入新 session 的 `ready`，旧结果不显示。
- 旧异步请求随后返回：Controller 丢弃结果并报告 `STALE_ANALYSIS_SESSION`。
- Phase 4B 出错：只更新 `learningAnalysisStatus`，不会改变 Phase 4A 的 `completed` 状态、原文案或原始逐字稿。

第一版不使用 `storage.local`、数据库或历史记录。

## API 防线

Extension 与 Backend 都执行基础响应验证：

- transcript 非空；
- 最大 50,000 字符，不静默截断；
- response `sourceSessionId` 必须匹配；
- 六个结果字段必须存在；
- `keyPoints` 为 3～8 个非空字符串；
- `structure` 至少一项且 title / summary 非空；
- timeout、Provider 不可用和无效响应使用独立错误码。

未来如果 Provider 上下文不足，可在 Provider/服务层加入 chunk strategy；Phase 4B-1 不实现 Map-Reduce。

## MV3 生命周期

音频 Blob 仍只存在于 Offscreen 内存和本地转写请求生命周期中，不通过 runtime message 序列化。学习整理只传递文本 JSON。Service Worker 持有 Controller，并将可序列化状态保存到 `chrome.storage.session`，Side Panel 只负责呈现和用户动作。

## 隐私边界

- Phase 3B / Phase 4A 默认在本机 `faster-whisper` 处理音频。
- Phase 4B-1 mock 在本机 Backend 内处理逐字稿，不访问外部 AI。
- Phase 4B-2 若启用远程 Provider，逐字稿文本可能发送给用户配置的服务；扩展仍不得持有第三方 API Key。

因此文档只对当前默认链路声明本地处理，不承诺未来所有文本分析永远全部本地。
