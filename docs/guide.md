# Web application guide

FreeDeepseek Web is designed to be used from its own browser interface. It does not provide a supported API for third-party applications.

## Requirements

- Node.js 18+
- Google Chrome
- A DeepSeek account

## First launch

```bash
npm run auth
npm run dashboard
```

The first command opens Chrome for DeepSeek sign-in and stores the account session locally. The second starts the web application. Open the local address printed by the launcher.

## Chat

Open **Chat** to start a conversation. Conversations are stored in the current browser profile. You can create multiple chats, rename them, search history, attach images, and stop a response.

## Accounts

Open **Accounts** to inspect the DeepSeek logins available to the application. Add or remove accounts there. Use the account selector in the chat sidebar to pin a conversation to one login or let the pool choose automatically.

A single DeepSeek Web login can serve one active chat at a time. Additional chats wait until that login is available; multiple accounts allow more parallel work.

## Status and usage

- **Status** shows whether the application can reach DeepSeek and whether accounts are ready.
- **Usage** shows token and request statistics.
- **Requests** shows recent requests and errors.

## Settings

Use **Settings** to change the theme, density, language, update channel, and local conversation data. If the server was started with `PROXY_API_KEY`, enter that key in the dashboard so its own browser requests can be authorized.

## Web-only architecture

The browser talks to private application routes such as `/app/chat` and `/app/models`. They exist only to support the web interface and may change without notice. The former OpenAI, Anthropic, and Responses API endpoints under `/v1/*` are disabled. Coding-agent setup and generated client configurations have been removed.

## Safety

The server listens on `127.0.0.1` by default. Keep it there unless you deliberately need remote browser access. For remote access, use a trusted private network or an HTTPS reverse proxy, set `PROXY_API_KEY`, and do not expose the service without a firewall or VPN.

## Troubleshooting

- Run `npm run doctor` to inspect the local setup.
- If DeepSeek sign-in expires, run `npm run auth` again.
- Check the terminal output if the dashboard cannot reach the server.

## Workspace mode

Enable **Workspace mode** with the terminal button in the chat toolbar. The assistant then receives tools for workspace files, public downloads, ZIP archives, and shell commands. Each conversation has its own persistent directory.

Build the isolated command image before using shell commands:

```bash
npm run workspace:build
```

Docker Engine must be running. Set `WORKSPACE_CONTAINER_RUNTIME=podman` to use Podman instead. Shell commands run as an unprivileged user in a container whose only writable host mount is that conversation's workspace. The container root is read-only, resource and time limits are applied, and network access is off by default. The dedicated downloader allows public HTTP(S) addresses only.
