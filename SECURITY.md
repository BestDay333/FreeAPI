# Security policy

FreeDeepseek Web is a browser-based application for managing and chatting with DeepSeek Web accounts. It does not expose a supported OpenAI, Anthropic, or third-party LLM API. The browser interface uses private application routes on the same server.

## Supported versions

Report problems against the latest commit on `main`. There is no separate long-term support line.

## Reporting a vulnerability

Use GitHub private vulnerability reporting:

https://github.com/dekrezz/FreeDeepseekAPI/security/advisories/new

Do not open a public issue, pull request, or chat that contains any of these:

- DeepSeek account files such as `deepseek-auth.json` or files from `accounts/`
- a token, cookie, or `PROXY_API_KEY`
- a live DeepSeek session id

Include the commit, the command you ran, and what you expected instead. A short request with secrets removed is enough.

## What we want to hear about

- Auth files created or read with permissions looser than mode `600`
- A remote client reaching the application when it is bound only to loopback
- `PROXY_API_KEY` ignored after it is set
- A token, cookie, or key copied into logs, error JSON, or a response body
- One local client reading or continuing another account's DeepSeek session
- Path or header handling that escapes the account files you configured

## What this policy does not cover

- DeepSeek rate-limiting, closing, or banning a web account. This project talks to [chat.deepseek.com](https://chat.deepseek.com), which can change or refuse a login.
- Binding `HOST` to `0.0.0.0` or a public address without protecting the web interface. That is the configuration you chose.
- Putting an auth file into an issue, a chat, or another application.

## Running it safely

- Leave the bind at `127.0.0.1` unless remote browser access is intentional.
- Keep `deepseek-auth.json` and `accounts/*.json` out of git. `npm run auth` writes account data with restrictive permissions.
- If you expose the web interface beyond your own machine, set `PROXY_API_KEY`, use HTTPS, and protect the service with a firewall or VPN.
- Do not treat the internal `/app/*` or `/admin/*` routes as a public API. They exist only for the web interface and may change.
- One DeepSeek login serves one chat at a time. Additional chats using the same login wait.
