# Phase 4B 正式规格：完整逐字稿 → 学习整理稿

## 目标与范围

Phase 4B 只消费已完成的 Phase 4A `FullTranscriptResult`，生成一份与原始逐字稿并存的学习整理结果。

Phase 4B 不重新捕获音频、不调用 `/api/transcribe`、不修改 Phase 4A session，也不覆盖原始逐字稿。

本阶段分为：

- Phase 4B-1：类型、Provider 抽象、配置、API、mock 全链路、独立状态与 Side Panel UI。
- Phase 4B-2：接入用户明确选择的真实文本分析 Provider。该阶段尚未开始。

历史记录、数据库、Markdown 下载、Web App、手机端、批量视频和自动翻译均不属于 Phase 4B。

## 输入

```ts
interface LearningAnalysisInput {
  sourceSessionId: string;
  tabId?: number;
  metadata: FullTranscriptResult["metadata"];
  caption?: string;
  transcript: string;
  transcriptLanguage?: string;
  outputLanguage: "zh";
}
```

启动条件：

1. Phase 4A `state === "completed"`；
2. `sessionId` 存在；
3. `FullTranscriptResult` 存在；
4. `transcript.text` 去除首尾空白后非空。

传给 Provider 的 `transcript` 必须保持 Phase 4A 原字符串，不得在 Extension 中截断、翻译或写回。

## 输出

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

字段规则：

- `cleanedTranscript`：忠实整理原口播，可补标点、合理分段、删除少量无意义语气词和明显重复；不得新增信息、大幅改写或自动翻译。
- `keyPoints`：3～8 条简洁核心观点，不得凭空增加结论。
- `structure`：按真实内容描述组织方式，不硬套模板，至少一项。
- `hooks`：保留原始开头表达并附简短类型说明，不创造营销文案；可以为空数组。
- `notableQuotes`：优先提取原措辞，没有明确金句时返回空数组。
- `learningNotes`：整理可复用方法、待验证观点和表达技巧，不重复全文摘要。

输入可以是中文、English、日本語、한국어或其他语言。`cleanedTranscript` 保持输入语言；分析字段默认中文。

## Provider 与 API

业务层只依赖独立 `TextAnalysisProvider`：

```ts
interface TextAnalysisProvider {
  analyze(input: LearningAnalysisInput): Promise<LearningAnalysisResult>;
}
```

Backend 端点为 `POST /api/analyze`。第三方 API Key 不得进入扩展。Phase 4B-1 的默认 Provider 为 `mock`，不得访问远程服务；OpenAI、DeepSeek、GLM、Doubao 和 Local LLM 均未接入。

Phase 4B-1 最大输入长度为 50,000 字符。超过限制返回 `ANALYSIS_INPUT_TOO_LONG`，不静默截断。未来可在 Provider 服务层加入 chunk strategy，本阶段不实现 Map-Reduce。

## 状态、Session 与存储

独立状态为：

```text
idle -> ready -> processing -> completed
                           \-> error
```

状态必须带 Phase 4A 来源 `sourceSessionId`。结果返回时必须再次匹配该值。当前 session 已改变时，旧完成或错误被丢弃并返回 `STALE_ANALYSIS_SESSION`。

状态保存在 `chrome.storage.session` 的独立 `learningAnalysisStatus` 项中。同一浏览器 session 内关闭再打开 Side Panel，应恢复同一来源 session 的完成结果。第一版不使用 `storage.local`、数据库或历史记录。

## 错误码

- `ANALYSIS_INPUT_EMPTY`
- `ANALYSIS_INPUT_TOO_LONG`
- `ANALYSIS_PROVIDER_UNAVAILABLE`
- `ANALYSIS_TIMEOUT`
- `ANALYSIS_INVALID_RESPONSE`
- `ANALYSIS_FAILED`
- `STALE_ANALYSIS_SESSION`

任何 Phase 4B 错误都不得修改 Phase 4A `completed` 状态。原视频文案、完整原始逐字稿及其复制操作必须继续可用。

## Side Panel

Phase 4A 完成后显示 `PHASE 4B · LEARNING` 区域。原始逐字稿非空时启用“生成学习整理”。处理中显示“正在整理完整逐字稿…”。完成后显示六类固定内容，并提供：

- 复制整理稿；
- 复制学习笔记；
- 复制全部学习内容。

Phase 4A 原始内容始终与 Phase 4B 派生内容同时保留。

## 隐私边界

Phase 4B-1 mock 只在本机 Backend 请求内存中处理逐字稿，不将文本发送到任何外部 AI 服务。Phase 4B-2 如果启用远程 Provider，逐字稿可能发送到用户明确配置的服务，必须在接入时更新隐私说明。

## Phase 4B-1 验收

- 正式类型、独立状态机与独立 session 关联存在；
- `/api/analyze` 和 mock `TextAnalysisProvider` 可完整返回六类结果；
- Side Panel 正确展示与复制结果；
- 原始逐字稿保持不变；
- 不触发音频捕获，不调用 `/api/transcribe`；
- `chrome.storage.session` 可恢复同 session 结果；
- 空输入、长文本、超时、Provider 不可用、无效响应和 stale session 均有明确错误；
- Extension typecheck/test/build 与 Backend pytest 全部通过；
- README 与架构文档同步。
