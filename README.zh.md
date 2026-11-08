# FreeDeepseek Web

为你自己的 DeepSeek 网页账号提供的网页聊天应用。你可以在一个浏览器界面中聊天、管理账号、查看用量并调整应用设置。

本项目有意采用**纯网页界面**。不再提供 OpenAI 兼容 API、Anthropic API，也不再集成 OpenCode、Cursor、Claude Code、Codex 或其他外部客户端。

## 环境要求

- Node.js 18 或更新版本
- Google Chrome
- DeepSeek 账号

## 启动

```bash
git clone https://github.com/BestDay333/FreeAPI.git
cd FreeAPI
npm run auth
npm run dashboard
```

1. `npm run auth` 会打开 Chrome，登录 DeepSeek 并创建本地账号会话。
2. `npm run dashboard` 会启动网页应用。打开终端中显示的地址。

## 应用功能

- **聊天** — 流式回答、浏览器本地聊天记录和图片附件。
- **账号** — 管理多个 DeepSeek 网页账号，并为聊天选择账号。
- **状态与用量** — 查看账号状态、请求记录和 token 统计。
- **设置** — 外观、语言、更新和本地聊天数据。

## 仅支持网页界面

本项目不再提供公开的 LLM API。应用只通过内部路由与自己的网页界面通信；这些路由属于实现细节，不是第三方集成 API。旧的 `/v1/*` 地址不再支持。

## 安全

服务器默认只监听 `127.0.0.1`。不要直接暴露到公共互联网。如果确实需要从其他设备访问网页界面，请使用可信的私有网络或正确配置的 HTTPS 反向代理，并设置 `PROXY_API_KEY`。

这是对 DeepSeek 网页聊天的非官方集成。DeepSeek 随时可能更改或限制该服务。

## 文档

- [网页应用指南](docs/zh/guide.md)
- [模型](docs/zh/models.md)
- [账号登录](docs/zh/auth.md)
- [安全](SECURITY.md)

## 许可证

Apache-2.0. Copyright 2026 dekrezz.
