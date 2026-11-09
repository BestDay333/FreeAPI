'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawn: defaultSpawn } = require('node:child_process');

const DEFAULT_SANDBOX_BINARY = 'bwrap';
const DEFAULT_LIMITER_BINARY = 'prlimit';
// Process limit for sandboxed commands. The kernel rejects clone(CLONE_NEWUSER)
// with EAGAIN ("Creating new namespace failed: Resource temporarily unavailable")
// when this is too low for the host user's process/namespace accounting, which
// made Bubblewrap fail before the command even started (seen on CachyOS).
const SANDBOX_NPROC = Math.max(256, Number(process.env.WORKSPACE_SANDBOX_NPROC) || 4096);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_MS = 300000;
const MAX_REDIRECTS = 5;

class WorkspaceError extends Error {
    constructor(message, type = 'workspace_error', status = 400) {
        super(message);
        this.name = 'WorkspaceError';
        this.type = type;
        this.status = status;
    }
}

function normalizeRelativePath(value, allowRoot = false) {
    if (typeof value !== 'string') throw new WorkspaceError('Path must be a string.', 'invalid_path');
    const input = value.trim().replace(/\\/g, '/');
    if (!input && allowRoot) return '';
    if (!input || input.includes('\0') || input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
        throw new WorkspaceError('Use a relative path inside the workspace.', 'invalid_path');
    }
    const parts = input.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new WorkspaceError('Path traversal and empty path segments are not allowed.', 'invalid_path');
    }
    return parts.join('/');
}

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function isPublicIp(address) {
    const version = net.isIP(address);
    if (version === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && (b === 0 || b === 168))
            || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
            || (a === 203 && b === 0));
    }
    if (version === 6) {
        const ip = address.toLowerCase().split('%')[0];
        if (ip.startsWith('::ffff:')) return isPublicIp(ip.slice(7));
        if (!(ip.startsWith('2') || ip.startsWith('3'))) return false;
        if (/^2001:(?:0|10|20|db8):/i.test(ip)) return false;
        return true;
    }
    return false;
}

function workspaceToolDefinitions() {
    const string = description => ({ type: 'string', description });
    const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
    return [
        { type: 'function', function: { name: 'workspace_list_files', description: 'List workspace files and directories. Use path="" for the root. Regular file entries include a signed download_url. Symbolic links cannot be opened.', parameters: object({ path: string('Relative directory path, or empty for root.') }) } },
        { type: 'function', function: { name: 'workspace_read_file', description: 'Read a UTF-8 text file from the workspace. The result includes a download_url for the original file. Do not use for binary files.', parameters: object({ path: string('Relative file path.') }, ['path']) } },
        { type: 'function', function: { name: 'workspace_write_file', description: 'Create or replace a UTF-8 text file; parent directories are created automatically. Maximum 20 MiB.', parameters: object({ path: string('Relative destination path.'), content: string('Complete UTF-8 content.') }, ['path', 'content']) } },
        { type: 'function', function: { name: 'workspace_create_directory', description: 'Create a directory and missing parents inside the workspace.', parameters: object({ path: string('Relative directory path.') }, ['path']) } },
        { type: 'function', function: { name: 'workspace_delete_file', description: 'Delete a file or empty directory. Non-empty directories are not recursively deleted.', parameters: object({ path: string('Relative file or empty directory path.') }, ['path']) } },
        { type: 'function', function: { name: 'workspace_rename_file', description: 'Rename or move a file or directory to another relative path inside this workspace.', parameters: object({ path: string('Current relative path.'), new_path: string('New relative path.') }, ['path', 'new_path']) } },
        { type: 'function', function: { name: 'workspace_download', description: 'Download a public HTTP(S) URL into the workspace. Private/local addresses and unsafe redirects are blocked. Maximum 500 MiB.', parameters: object({ url: string('Public HTTP or HTTPS URL.'), path: string('Relative destination path.') }, ['url', 'path']) } },
        { type: 'function', function: { name: 'workspace_run', description: 'Run a shell command directly on the computer running this local FreeAPI server, inside a Bubblewrap Linux namespace. Only the current conversation workspace is writable; the host home directory and other host files are not mounted. CPU time, processes, file size, wall time and output are limited. Network is off by default; set network=true only when internet access is needed. After creating files, call workspace_list_files to get signed download links.', parameters: object({ command: string('Shell command to run.'), cwd: string('Optional relative working directory.'), timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_COMMAND_MS }, network: { type: 'boolean', description: 'Allow outbound internet for this command; defaults to false.' } }, ['command']) } },
        { type: 'function', function: { name: 'workspace_archive', description: 'Create a downloadable ZIP archive of a workspace file or directory.', parameters: object({ source: string('Relative source file or directory.'), destination: string('Optional relative ZIP destination.') }, ['source']) } }
    ];
}

function createWorkspaceManager(options = {}) {
    const root = path.resolve(options.root || path.join(process.cwd(), 'data', 'workspaces'));
    const sandboxBinary = options.sandboxBinary || process.env.WORKSPACE_SANDBOX_BINARY || DEFAULT_SANDBOX_BINARY;
    const limiterBinary = options.limiterBinary || process.env.WORKSPACE_LIMITER_BINARY || DEFAULT_LIMITER_BINARY;
    const spawnImpl = options.spawnImpl || defaultSpawn;
    const maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES;
    const maxDownloadBytes = options.maxDownloadBytes || MAX_DOWNLOAD_BYTES;
    const maxOutputBytes = options.maxOutputBytes || MAX_OUTPUT_BYTES;
    const maxCommandMs = options.maxCommandMs || MAX_COMMAND_MS;
    const makeDownloadUrl = options.downloadUrlForPath || (relative => '/app/workspace/download?path=' + encodeURIComponent(relative));

    async function alignOwnership() {
        // Native Bubblewrap namespaces map the FreeAPI process user into the sandbox.
        // Keep workspace files owned by that same host user; do not chown to a container UID.
    }

    async function ensureRoot() {
        await fsp.mkdir(root, { recursive: true, mode: 0o700 });
        const stat = await fsp.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceError('Workspace root must be a real directory.', 'unsafe_workspace_root', 500);
        await alignOwnership(root);
        return root;
    }

    async function inspect(relative, { allowRoot = false, createParents = false } = {}) {
        const normalized = normalizeRelativePath(relative, allowRoot);
        await ensureRoot();
        const parts = normalized ? normalized.split('/') : [];
        let current = root;
        for (let index = 0; index < parts.length; index++) {
            current = path.join(current, parts[index]);
            const last = index === parts.length - 1;
            try {
                const stat = await fsp.lstat(current);
                if (stat.isSymbolicLink()) throw new WorkspaceError('Symbolic links cannot be followed.', 'symlink_blocked', 403);
                if (!last && !stat.isDirectory()) throw new WorkspaceError('A parent path component is not a directory.', 'not_a_directory');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                if (createParents && !last) {
                    await fsp.mkdir(current, { mode: 0o700 });
                    await alignOwnership(current);
                }
            }
        }
        return { absolute: current, relative: normalized };
    }

    async function listFiles(relative = '') {
        const target = await inspect(relative, { allowRoot: true });
        let names;
        try { names = await fsp.readdir(target.absolute); }
        catch (error) { if (error.code === 'ENOENT') throw new WorkspaceError('Directory does not exist.', 'not_found', 404); throw error; }
        if (!target.relative) names = names.filter(name => name !== '.runtime');
        const entries = [];
        for (const name of names.slice(0, 500)) {
            const stat = await fsp.lstat(path.join(target.absolute, name));
            const entryPath = target.relative ? target.relative + '/' + name : name;
            entries.push({
                name,
                path: entryPath,
                type: stat.isSymbolicLink() ? 'link' : (stat.isDirectory() ? 'directory' : 'file'),
                size: stat.isFile() ? stat.size : null,
                modified_at: stat.mtime.toISOString(),
                download_url: stat.isFile() ? makeDownloadUrl(entryPath) : undefined
            });
        }
        entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
        return { path: target.relative, entries, truncated: names.length > entries.length };
    }

    async function readFile(relative) {
        const target = await inspect(relative);
        let handle;
        try { handle = await fsp.open(target.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
        catch (error) {
            if (error.code === 'ENOENT') throw new WorkspaceError('File does not exist.', 'not_found', 404);
            if (error.code === 'ELOOP') throw new WorkspaceError('Symbolic links cannot be read.', 'symlink_blocked', 403);
            throw error;
        }
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new WorkspaceError('Path is not a regular file.', 'not_a_file');
            if (stat.size > maxFileBytes) throw new WorkspaceError('File is too large for a text read.', 'file_too_large', 413);
            const buffer = await handle.readFile();
            if (buffer.includes(0)) throw new WorkspaceError('This is a binary file. Download it instead of opening it as text.', 'binary_file', 415);
            let content;
            try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
            catch { throw new WorkspaceError('This file is not valid UTF-8 text. Download it instead.', 'binary_file', 415); }
            return { path: target.relative, size: stat.size, content, download_url: makeDownloadUrl(target.relative) };
        } finally { await handle.close(); }
    }

    async function writeFile(relative, content) {
        if (typeof content !== 'string') throw new WorkspaceError('File content must be text.', 'invalid_content');
        const size = Buffer.byteLength(content, 'utf8');
        if (size > maxFileBytes) throw new WorkspaceError('File exceeds the 20 MiB limit.', 'file_too_large', 413);
        const target = await inspect(relative, { createParents: true });
        let handle;
        try {
            handle = await fsp.open(target.absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
        } catch (error) {
            if (error.code === 'ELOOP') throw new WorkspaceError('Symbolic links cannot be overwritten.', 'symlink_blocked', 403);
            throw error;
        }
        try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
        await alignOwnership(target.absolute);
        return { path: target.relative, size, download_url: makeDownloadUrl(target.relative) };
    }

    async function createDirectory(relative) {
        const target = await inspect(relative, { createParents: true });
        await fsp.mkdir(target.absolute, { recursive: true, mode: 0o700 });
        await alignOwnership(target.absolute);
        return { path: target.relative, created: true };
    }

    async function deleteFile(relative) {
        const target = await inspect(relative);
        const stat = await fsp.lstat(target.absolute);
        if (stat.isDirectory() && !stat.isSymbolicLink()) await fsp.rmdir(target.absolute);
        else await fsp.unlink(target.absolute);
        return { path: target.relative, deleted: true };
    }

    async function renameFile(sourceValue, destinationValue) {
        const source = await inspect(sourceValue);
        const destination = await inspect(destinationValue);
        if (source.relative === destination.relative) throw new WorkspaceError('The new name is the same as the current name.', 'same_path');
        const sourceStat = await fsp.lstat(source.absolute).catch(error => {
            if (error.code === 'ENOENT') throw new WorkspaceError('Source does not exist.', 'not_found', 404);
            throw error;
        });
        if (sourceStat.isSymbolicLink()) throw new WorkspaceError('Symbolic links cannot be renamed.', 'symlink_blocked', 403);
        if (sourceStat.isDirectory()) {
            const nested = path.relative(source.absolute, destination.absolute);
            if (nested === '' || (!path.isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + path.sep))) {
                throw new WorkspaceError('A folder cannot be moved inside itself.', 'invalid_path');
            }
        }
        try {
            await fsp.lstat(destination.absolute);
            throw new WorkspaceError('A file or folder with that name already exists.', 'already_exists', 409);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await fsp.rename(source.absolute, destination.absolute);
        return { path: source.relative, new_path: destination.relative, renamed: true };
    }

    async function runCommand({ command, cwd = '', timeout_ms = maxCommandMs, network = false } = {}) {
        if (process.platform !== 'linux') {
            throw new WorkspaceError('Local command execution currently requires Linux and Bubblewrap.', 'sandbox_unsupported', 501);
        }
        if (typeof command !== 'string' || !command.trim()) throw new WorkspaceError('Command must be a non-empty string.', 'invalid_command');
        if (command.length > 20000) throw new WorkspaceError('Command is too long.', 'command_too_large', 413);
        const timeout = Math.max(1000, Math.min(Number(timeout_ms) || maxCommandMs, maxCommandMs));
        const normalizedCwd = normalizeRelativePath(cwd, true);
        await ensureRoot();
        const workDir = await inspect(normalizedCwd, { allowRoot: true });
        const cwdStat = await fsp.lstat(workDir.absolute).catch(error => {
            if (error.code === 'ENOENT') throw new WorkspaceError('Working directory does not exist.', 'not_found', 404);
            throw error;
        });
        if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()) throw new WorkspaceError('Working path must be a real directory.', 'not_a_directory');

        // Keep package-manager caches inside the mounted workspace, never in the user's real home.
        for (const relative of ['.runtime', '.runtime/home', '.runtime/cache', '.runtime/config', '.runtime/data', '.runtime/npm', '.runtime/pip', '.runtime/cargo', '.runtime/go']) {
            const target = await inspect(relative, { createParents: true });
            await fsp.mkdir(target.absolute, { recursive: true, mode: 0o700 });
            const stat = await fsp.lstat(target.absolute);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceError('Workspace runtime cache contains an unsafe path.', 'symlink_blocked', 403);
            await alignOwnership(target.absolute);
        }

        if (!fs.existsSync('/usr') || !fs.existsSync('/etc')) {
            throw new WorkspaceError('This Linux system is missing /usr or /etc, so the local sandbox cannot be prepared.', 'sandbox_unavailable', 503);
        }

        const sandboxArgs = [
            '--die-with-parent',
            '--new-session',
            '--unshare-user',
            '--disable-userns',
            '--assert-userns-disabled',
            '--unshare-pid',
            '--unshare-ipc',
            '--unshare-uts',
        ];
        if (network !== true) sandboxArgs.push('--unshare-net');

        // System software is visible read-only. The user's home, /mnt and
        // unrelated host runtime services are intentionally not mounted.
        // If resolv.conf is a systemd/NetworkManager symlink, expose only its
        // resolver directory so explicitly network-enabled commands can resolve DNS.
        try {
            const resolverFile = fs.realpathSync('/etc/resolv.conf');
            const resolverDir = path.dirname(resolverFile);
            if (resolverDir.startsWith('/run/') && resolverDir !== '/run') {
                sandboxArgs.push('--dir', '/run');
                let current = '/run';
                for (const part of path.relative('/run', resolverDir).split(path.sep).filter(Boolean)) {
                    current = path.join(current, part);
                    sandboxArgs.push('--dir', current);
                }
                sandboxArgs.push('--ro-bind', resolverDir, resolverDir);
            }
        } catch { /* /etc/resolv.conf may already be a regular file */ }
        sandboxArgs.push('--ro-bind', '/usr', '/usr');
        sandboxArgs.push('--ro-bind', '/etc', '/etc');
        if (fs.existsSync('/opt')) sandboxArgs.push('--ro-bind', '/opt', '/opt');
        sandboxArgs.push(
            '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/bin', '/sbin',
            '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib', '/lib64',
            '--proc', '/proc',
            '--dev', '/dev',
            '--tmpfs', '/tmp',
            '--dir', '/home',
            '--tmpfs', '/home',
            '--dir', '/root',
            '--tmpfs', '/root',
            '--dir', '/workspace',
            '--bind', root, '/workspace',
            '--chdir', normalizedCwd ? '/workspace/' + normalizedCwd : '/workspace',
            '--clearenv',
            '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            '--setenv', 'HOME', '/workspace/.runtime/home',
            '--setenv', 'XDG_CACHE_HOME', '/workspace/.runtime/cache',
            '--setenv', 'XDG_CONFIG_HOME', '/workspace/.runtime/config',
            '--setenv', 'XDG_DATA_HOME', '/workspace/.runtime/data',
            '--setenv', 'NPM_CONFIG_CACHE', '/workspace/.runtime/npm',
            '--setenv', 'PIP_CACHE_DIR', '/workspace/.runtime/pip',
            '--setenv', 'CARGO_HOME', '/workspace/.runtime/cargo',
            '--setenv', 'GOPATH', '/workspace/.runtime/go',
            '--setenv', 'TMPDIR', '/tmp',
            '--setenv', 'TMP', '/tmp',
            '--setenv', 'TEMP', '/tmp',
            '--setenv', 'LANG', 'C.UTF-8',
            '--setenv', 'TERM', 'xterm-256color',
            '--cap-drop', 'ALL',
            '/bin/bash', '-lc',
            'ulimit -t 300; ulimit -u ' + SANDBOX_NPROC + '; ulimit -f 2097152; exec /bin/bash -lc ' + shellQuote(command)
        );
        const launchArgs = [
            '--as=12884901888',
            '--nproc=' + SANDBOX_NPROC,
            '--fsize=1073741824',
            '--cpu=300',
            '--',
            sandboxBinary,
            ...sandboxArgs,
        ];

        return new Promise((resolve, reject) => {
            let child;
            let stdout = '';
            let stderr = '';
            let totalBytes = 0;
            let timedOut = false;
            let outputLimited = false;
            let settled = false;
            let timer = null;
            let killTimer = null;
            const stop = () => {
                if (!child || settled) return;
                try { child.kill('SIGTERM'); } catch {}
                clearTimeout(killTimer);
                killTimer = setTimeout(() => { if (!settled) { try { child.kill('SIGKILL'); } catch {} } }, 2000);
                killTimer.unref && killTimer.unref();
            };
            const finish = (error, code, signal) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(killTimer);
                if (error) {
                    if (error.code === 'ENOENT') {
                        return reject(new WorkspaceError(
                            'Bubblewrap or prlimit is not installed. On Arch/CachyOS run: sudo pacman -S bubblewrap util-linux',
                            'sandbox_unavailable', 503
                        ));
                    }
                    return reject(new WorkspaceError('Could not start the local sandbox: ' + error.message, 'sandbox_unavailable', 503));
                }
                resolve({
                    command,
                    cwd: normalizedCwd,
                    exit_code: code,
                    signal,
                    timed_out: timedOut,
                    output_limited: outputLimited,
                    stdout,
                    stderr,
                    network: network === true,
                    runner: 'bubblewrap',
                });
            };
            const append = (target, chunk) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
                totalBytes += buffer.length;
                const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
                if (remaining > 0) target(buffer.subarray(0, remaining).toString('utf8'));
                if (totalBytes > maxOutputBytes && !outputLimited) { outputLimited = true; stop(); }
            };
            try {
                child = spawnImpl(limiterBinary, launchArgs, {
                    cwd: root,
                    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                });
            } catch (error) {
                finish(error);
                return;
            }
            timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
            if (child.stdout) child.stdout.on('data', chunk => append(value => { stdout += value; }, chunk));
            if (child.stderr) child.stderr.on('data', chunk => append(value => { stderr += value; }, chunk));
            child.once('error', error => finish(error));
            child.once('close', (code, signal) => finish(null, code, signal));
        });
    }

    async function publicAddresses(hostname) {
        if (net.isIP(hostname)) throw new WorkspaceError('IP-literal URLs are not allowed.', 'unsafe_url', 403);
        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) {
            throw new WorkspaceError('URL resolves to a local, private or reserved network.', 'unsafe_url', 403);
        }
        return addresses;
    }

    async function downloadUrl(urlValue, relative) {
        const target = await inspect(relative, { createParents: true });
        const temp = target.absolute + '.part-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        let parsed;
        try { parsed = new URL(urlValue); } catch { throw new WorkspaceError('URL is not valid.', 'invalid_url'); }
        const initialProtocol = parsed.protocol;
        try {
            for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
                    throw new WorkspaceError('Only public HTTP(S) URLs without embedded credentials are allowed.', 'unsafe_url', 403);
                }
                const addresses = await publicAddresses(parsed.hostname);
                const result = await new Promise((resolve, reject) => {
                    const client = parsed.protocol === 'https:' ? https : http;
                    const lookup = (hostname, opts, callback) => {
                        if (opts && opts.all) return callback(null, addresses);
                        const chosen = addresses.find(item => !opts || !opts.family || item.family === opts.family) || addresses[0];
                        callback(null, chosen.address, chosen.family);
                    };
                    const request = client.get({
                        protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || undefined,
                        path: parsed.pathname + parsed.search, servername: parsed.hostname, lookup,
                        headers: { 'User-Agent': 'FreeAPI-Workspace/1.0', Accept: '*/*' }, timeout: 30000
                    }, response => {
                        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                            const location = response.headers.location;
                            response.resume();
                            if (!location) return reject(new WorkspaceError('Redirect has no Location header.', 'download_redirect', 502));
                            resolve({ redirect: location });
                            return;
                        }
                        if (response.statusCode < 200 || response.statusCode >= 300) {
                            response.resume();
                            reject(new WorkspaceError('Download server returned HTTP ' + response.statusCode + '.', 'download_failed', 502));
                            return;
                        }
                        const declared = Number(response.headers['content-length'] || 0);
                        if (declared > maxDownloadBytes) {
                            response.destroy();
                            reject(new WorkspaceError('Download exceeds the 100 MiB limit.', 'download_too_large', 413));
                            return;
                        }
                        const output = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
                        let bytes = 0;
                        response.on('data', chunk => {
                            bytes += chunk.length;
                            if (bytes > maxDownloadBytes) {
                                request.destroy(new WorkspaceError('Download exceeds the 100 MiB limit.', 'download_too_large', 413));
                                output.destroy();
                            }
                        });
                        output.once('error', reject);
                        response.once('error', reject);
                        output.once('finish', () => output.close(error => error ? reject(error) : resolve({
                            bytes, content_type: response.headers['content-type'] || 'application/octet-stream'
                        })));
                        response.pipe(output);
                    });
                    request.once('timeout', () => request.destroy(new WorkspaceError('Download timed out.', 'download_timeout', 504)));
                    request.once('error', reject);
                });
                if (result.redirect) {
                    if (redirects === MAX_REDIRECTS) throw new WorkspaceError('Too many redirects.', 'download_redirect', 502);
                    const next = new URL(result.redirect, parsed);
                    if (initialProtocol === 'https:' && next.protocol !== 'https:') throw new WorkspaceError('HTTPS cannot redirect to HTTP.', 'unsafe_url', 403);
                    parsed = next;
                    continue;
                }
                await fsp.rename(temp, target.absolute);
                await alignOwnership(target.absolute);
                return { path: target.relative, size: result.bytes, content_type: result.content_type, download_url: makeDownloadUrl(target.relative) };
            }
            throw new WorkspaceError('Download failed.', 'download_failed', 502);
        } catch (error) {
            await fsp.rm(temp, { force: true }).catch(() => {});
            throw error;
        }
    }

    async function archive(sourceValue, destinationValue) {
        const source = normalizeRelativePath(sourceValue);
        const sourceInfo = await inspect(source);
        const sourceStat = await fsp.lstat(sourceInfo.absolute).catch(error => {
            if (error.code === 'ENOENT') throw new WorkspaceError('Archive source does not exist.', 'not_found', 404);
            throw error;
        });
        if (sourceStat.isSymbolicLink()) throw new WorkspaceError('Symbolic links cannot be archived.', 'symlink_blocked', 403);
        const destination = destinationValue ? normalizeRelativePath(destinationValue) : 'archives/' + path.basename(source) + '-' + Date.now() + '.zip';
        if (!destination.toLowerCase().endsWith('.zip')) throw new WorkspaceError('Archive destination must end in .zip.', 'invalid_archive_path');
        const nestedDestination = path.relative(sourceInfo.absolute, path.join(root, destination));
        if (nestedDestination === '' || (!path.isAbsolute(nestedDestination) && nestedDestination !== '..' && !nestedDestination.startsWith('..' + path.sep))) {
            throw new WorkspaceError('The ZIP destination cannot be the source or a location inside the source directory.', 'invalid_archive_path');
        }
        await inspect(destination, { createParents: true });
        const result = await runCommand({ command: 'zip -q -r ' + shellQuote(destination) + ' ' + shellQuote(source), timeout_ms: maxCommandMs });
        if (result.exit_code !== 0) throw new WorkspaceError('ZIP creation failed (exit ' + result.exit_code + '). ' + (result.stderr || result.stdout).slice(0, 1000), 'archive_failed', 500);
        const output = await inspect(destination);
        const stat = await fsp.lstat(output.absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceError('ZIP output is not a regular file.', 'archive_failed', 500);
        return { path: destination, size: stat.size, download_url: makeDownloadUrl(destination) };
    }

    async function openDownload(relative) {
        const target = await inspect(relative);
        let handle;
        try { handle = await fsp.open(target.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
        catch (error) {
            if (error.code === 'ENOENT') throw new WorkspaceError('File does not exist.', 'not_found', 404);
            if (error.code === 'ELOOP') throw new WorkspaceError('Symbolic links cannot be downloaded.', 'symlink_blocked', 403);
            throw error;
        }
        const stat = await handle.stat();
        if (!stat.isFile()) { await handle.close(); throw new WorkspaceError('Only regular files can be downloaded.', 'not_a_file'); }
        return { handle, stat, path: target.relative };
    }

    return { root, ensureRoot, listFiles, readFile, writeFile, createDirectory, deleteFile, renameFile, runCommand, downloadUrl, archive, openDownload };
}

const MAX_TOOL_RESULT_CHARS = 96000;

function compactWorkspaceToolResult(result) {
    let json = JSON.stringify(result);
    if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return JSON.stringify({ error: 'Tool result exceeded the 48,000 character limit.', type: 'tool_result_too_large' });
    }
    const compact = { ...result, truncated: true };
    for (const field of ['content', 'stdout', 'stderr']) {
        if (typeof compact[field] === 'string' && compact[field].length > 24000) {
            compact[field] = compact[field].slice(0, 24000);
            compact.truncated_fields = [...(compact.truncated_fields || []), field];
        }
    }
    if (Array.isArray(compact.entries)) {
        compact.entries = compact.entries.slice(0, 100);
        while (compact.entries.length && JSON.stringify(compact).length > MAX_TOOL_RESULT_CHARS) compact.entries.pop();
    }
    json = JSON.stringify(compact);
    if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
    return JSON.stringify({
        error: 'Tool result was too large to pass to the model. Narrow the file listing or read a smaller section.',
        type: 'tool_result_too_large',
        truncated: true
    });
}

async function executeWorkspaceTool(manager, name, args = {}) {
    let result;
    switch (name) {
        case 'workspace_list_files': result = await manager.listFiles(args.path || ''); break;
        case 'workspace_read_file': result = await manager.readFile(args.path); break;
        case 'workspace_write_file': result = await manager.writeFile(args.path, args.content); break;
        case 'workspace_create_directory': result = await manager.createDirectory(args.path); break;
        case 'workspace_delete_file': result = await manager.deleteFile(args.path); break;
        case 'workspace_rename_file': result = await manager.renameFile(args.path, args.new_path); break;
        case 'workspace_download': result = await manager.downloadUrl(args.url, args.path); break;
        case 'workspace_run': result = await manager.runCommand({ command: args.command, cwd: args.cwd || '', timeout_ms: args.timeout_ms, network: args.network === true }); break;
        case 'workspace_archive': result = await manager.archive(args.source, args.destination); break;
        default: throw new WorkspaceError('Unknown workspace tool: ' + name, 'unknown_tool');
    }
    return compactWorkspaceToolResult(result);
}

module.exports = { WorkspaceError, createWorkspaceManager, workspaceToolDefinitions, executeWorkspaceTool, compactWorkspaceToolResult, normalizeRelativePath, isPublicIp, shellQuote, DEFAULT_SANDBOX_BINARY, DEFAULT_LIMITER_BINARY };
