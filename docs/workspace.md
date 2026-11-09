# Local workspace

Workspace tools run on the same computer as the FreeAPI server. Each conversation gets its own persistent directory under `data/workspaces/`.

## File manager

Open the folder/files button in the chat toolbar. The manager is scoped to the active conversation and supports directory browsing, text preview and editing, save, create file/folder, rename, delete, and download. Directories can only be deleted when empty. Binary and non-UTF-8 files are downloadable but are not opened in the text editor.

## Install

On Arch Linux / CachyOS:

```bash
sudo pacman -S bubblewrap util-linux
npm run workspace:check
```

Bubblewrap creates Linux namespaces. Only the active conversation workspace is writable; host home directories, `/mnt`, and Docker sockets are not mounted. System directories are read-only.

## Limits

- Text file read/write: 20 MiB.
- Public HTTP(S) downloads: 500 MiB.
- Shell output: 4 MiB.
- One command: up to 5 minutes.
- Workspace request deadline: 30 minutes by default.
- 16 tool actions per model pass.
- Process address-space limit: 12 GiB; 768 processes; maximum file size: 1 GiB.

Actual build speed and memory availability depend on the host computer.

## Network

Shell networking is disabled by default and can be enabled per command. The dedicated downloader blocks localhost, private/reserved addresses, and unsafe redirects.

## Verify

```bash
npm run workspace:check
npm test
```
