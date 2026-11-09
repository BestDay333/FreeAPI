# FreeDeepseek Web

A private web chat for your own DeepSeek Web account. Chat, manage accounts, review usage and adjust the application from one browser interface.

This project is intentionally **web-only**. It does not expose an OpenAI-compatible API, Anthropic API, or integrations for OpenCode, Cursor, Claude Code, Codex, or other external clients.

## Requirements

- Node.js 18 or newer
- Google Chrome
- A DeepSeek account

## Start

```bash
git clone https://github.com/BestDay333/FreeAPI.git
cd FreeAPI
npm run auth
npm run dashboard
```

1. `npm run auth` opens Chrome so you can sign in to DeepSeek and create the local account session.
2. `npm run dashboard` starts the web application. Open the address printed in the terminal.

## What is included

- **Chat** — stream answers, keep conversation history in your browser, and attach images.
- **Accounts** — manage multiple DeepSeek Web logins and choose which account a chat uses.
- **Status and usage** — see account health, request history, and token statistics.
- **Settings** — change appearance, language, updates, and local chat data.

## Web-only by design

There is no public LLM endpoint. The application uses private internal routes for its own browser interface; those routes are implementation details and are not a supported integration API. Requests to the former `/v1/*` endpoints are no longer supported.

## Safety

The server binds to `127.0.0.1` by default. Do not expose it directly to the public internet. If you intentionally make the web interface available on another device, protect it with a trusted private network or a properly configured HTTPS reverse proxy and set `PROXY_API_KEY`.

This is an unofficial integration with DeepSeek's web chat. DeepSeek can change or restrict that service at any time.

## Documentation

- [Web guide](docs/guide.md)
- [Models](docs/models.md)
- [Account login](docs/auth.md)
- [Security](SECURITY.md)
- [Workspace guide](docs/workspace.md)

## License

Apache-2.0. Copyright 2026 dekrezz.

## Workspace mode

The chat has an optional **Workspace mode** switch. When enabled, the assistant can list, read, create and delete files in a persistent workspace, download public HTTP(S) files, create ZIP archives, and run shell commands.

Commands run directly on the computer hosting this FreeAPI process, inside a Bubblewrap Linux namespace. Only the current conversation's workspace is writable; the user's home directory and other host files are not mounted. CPU time, process count, file size, wall time and output are limited. Network access for shell commands is off by default and can be enabled for a task when needed. The dedicated downloader accepts public HTTP(S) addresses only.

On Arch Linux or CachyOS install the local sandbox dependency:

```bash
sudo pacman -S bubblewrap util-linux
npm run workspace:check
```

Workspace files are stored under `data/workspaces/` and are excluded from Git. Download links are signed and expire after 24 hours.
