# Resolver report format

每次实验可以通过 `--output` 写出一个 JSON 报告。报告的顶层字段如下：

| 字段 | 含义 |
| --- | --- |
| `status` | `success`、`partial`、`blocked` 或 `error` |
| `input` | 输入分享链接和域名校验结果 |
| `navigation` | 最终 URL、响应状态和普通浏览器重定向链 |
| `video` | 视频 ID、作者、标题/描述、页面可见文字及来源证据 |
| `subtitles` | 可见字幕、`track`、浏览器 text track 的检测结果 |
| `audio` | 页面媒体元素、来源 URL 类型和当前页面可用状态 |
| `warnings` | 字段缺失、页面仍加载或访问受限等非致命问题 |
| `errors` | 导航或浏览器执行失败 |
| `logs` | 带时间、阶段、事件和结构化详情的完整日志 |

媒体 URL 和日志中的 URL 会对 query/hash 做脱敏，避免把可能带签名的临时地址写入报告。模块只判断页面是否存在媒体来源，不下载媒体、不转码、不转写。
