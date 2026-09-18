# Douyin Content Resolver experiment

这是一个独立的技术验证模块，不属于 Phase 3。它使用本机已安装的 Chrome 或 Edge，通过普通浏览器导航和页面 DOM 读取，验证抖音分享链接公开可见的信息边界。

## 能做什么

- 跟随普通 HTTP/HTTPS 重定向并记录最终页面 URL；
- 从 URL、页面链接、公开 DOM 数据属性和公开 meta 信息解析视频 ID；
- 读取作者、视频标题/描述和 `document.body.innerText`；
- 检查可见字幕节点、字幕 `track` 和浏览器 text track；
- 检查 `video`/`audio` 元素、`currentSrc`、`source` 和性能资源提示；
- 输出结构化终端日志和 JSON 报告。

不会调用抖音私有 API，不绕过登录、验证码或反爬，不使用用户登录态，不下载或转写音频。

## 使用

在仓库根目录执行：

```powershell
npm install
npm run resolver:typecheck
npm run resolver:test
npm run resolver:build
npm run resolver -- --url "https://v.douyin.com/你的分享链接/" --output "reports/latest.json"
```

如果自动找不到浏览器，可显式指定：

```powershell
npm run resolver -- --url "https://v.douyin.com/你的分享链接/" --browser-path "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
```

默认使用 headless Chrome/Edge。加 `--headed` 可以观察普通浏览器窗口中的跳转和页面状态。`--timeout` 可以调整导航超时时间。

## 如何理解结果

`audio.exists` 只表示页面发现了媒体来源；`audio.usableInPage` 表示媒体元素已经达到浏览器可播放数据状态。`blob:` 来源只在当前页面上下文中可见，不能据此承诺后续可以直接下载。

`subtitles.exists` 发现可见字幕文本时可信度最高；只有隐藏的 `track` 或 text track 时标记为 `weak`，因为存在字幕轨道不代表当前页面已经显示字幕。

报告格式说明位于 `experiments/content-resolver/reports/README.md`。
