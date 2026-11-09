# Local workspace

Workspace commands execute on the same computer that runs the FreeAPI server. If FreeAPI is running on the user's PC, no VDS is involved.

## Setup

On Arch Linux / CachyOS:

```bash
sudo pacman -S bubblewrap util-linux
npm run workspace:check
```

Bubblewrap creates isolated Linux namespaces. Only the current conversation's workspace is mounted writable. System software is read-only; the user's home directory, `/run`, `/mnt`, and the Docker socket are not mounted.

## Files

Workspace files are stored locally under `data/workspaces/`, with one directory per conversation. They survive FreeAPI restarts and are excluded from Git.

Deliverables can be downloaded from the chat's workspace file browser. The dedicated downloader allows public HTTP(S) addresses and blocks local/private network targets.

## Commands and internet

Shell commands run inside a Linux namespace. Network access for shell commands is disabled by default; the model should enable it only when a task requires package installs or Git downloads. The dedicated `workspace_download` tool can fetch public HTTP(S) files separately.

Command execution is bounded by wall time, CPU time, process count, file size and output limits. It cannot see the host home directory or other host files.

## Verification

```bash
npm run workspace:check
npm test
```

The sandbox check should print `Local workspace sandbox is ready`. If namespace creation is denied, check whether unprivileged user namespaces are enabled by the kernel.
